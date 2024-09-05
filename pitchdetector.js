
/*
The MIT License (MIT)

Copyright (c) 2014-2015 Chris Wilson, modified by Mark Marijnissen,
converted to AudioWorkletProcessor + ES6 by Ash Weeks

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteToFrequency( note ) {
		return 440 * Math.pow(2,(note-69)/12);
}

function noteToPeriod (note, sampleRate) {
		return sampleRate / noteToFrequency(note);
}

function frequencyToNote( frequency ) {
		const noteNum = 12 * (Math.log( frequency / 440 )/Math.log(2) );
		return Math.round( noteNum ) + 69;
}

function frequencyToString( frequency ){
		const note = frequencyToNote(frequency);
		return noteStrings[note % 12] + Math.floor((note-12) / 12);
}

function centsOffFromPitch( frequency, note ) {
		return Math.floor( 1200 * Math.log( frequency / noteToFrequency( note ))/Math.log(2) );
}

function getLiveInput(context,callback){
		try {
				navigator.mediaDevices.getUserMedia({
						audio: {
								mandatory: {
										echoCancellation: false,
										autoGainControl: false,
										noiseSuppression: false,
										highpassFilter: false
								},
						}
				}).then(stream => {
						const liveInputNode = context.createMediaStreamSource(stream);
						callback(null, liveInputNode);
				}).catch(error => {
						console.error('getUserMedia error', error);
						callback(error,null);
				});
		} catch(e) {
				console.error('getUserMedia exception', e);
				callback(e,null);
		}
}

export class PitchDetector {
		constructor(options) {

				// Options:
				this.options = {
						minRms: 0.01,
						interpolateFrequency: true,
						stopAfterDetection: false,
						normalize: false,
						minCorrelation: false,
						length: options.length,
						minCorrelationIncrease: false
				};

				// Internal Variables
				this.context = options.context; // AudioContext
				this.sampleRate = this.context.sampleRate; // sampleRate
				this.isLoading = false;
				//this.buffer = new Float32Array( options.length || 1024 ); // buffer array
				this.started = false; // state flag (to cancel requestAnimationFrame)
				this.input = null;	  // Audio Input Node
				this.output = null;   // Audio Output Node

				// Stats:
				this.stats = {
						detected: false,
						frequency: -1,
						best_period: 0,
						worst_period: 0,
						best_correlation: 0.0,
						worst_correlation: 0.0,
						time: 0.0,
						rms: 0.0,
				};

				this.lastOnDetect = 0.0;

				// Set input
				if(!options.input){
						const self = this;
						getLiveInput(this.context,(err, input) => {
								if(err){
										console.error('getUserMedia error:',err);
								} else {
										self.input = input;
										self.start();
								}
						});
				} else {
						this.input = options.input;
				}

				// Set output
				if(options.output){
						this.output = options.output;
				}

				// Set options
				this.setOptions(options, true);
		}

		setOptions(options, ignoreConstructorOnlyProperties) {
				const self = this;

				// Override options (if defined)
				['minCorrelation','minCorrelationIncrease','minRms',
						'normalize','stopAfterDetection','interpolateFrequency',
						'workerPath', 'start', 'onDebug','onDetect','onDestroy'
				].forEach(option => {
						if(typeof options[option] !== 'undefined') {
								self.options[option] = options[option];
						}
				});

				if(ignoreConstructorOnlyProperties !== true){
						// Warn if you're setting Constructor-only options!
						['input','output','length','context'].forEach(option => {
								if(typeof options[option] !== 'undefined'){
										console.warn('PitchDetector: Cannot set option "'+option+'"" after construction!');
								}
						});
				}

				// keep track of stats for visualization
				if (options.onDebug) {
						this.debug = {
								detected: false,
								frequency: -1,
								best_period: 0,
								worst_period: 0,
								best_correlation: 0.0,
								worst_correlation: 0.0,
								time: 0.0,
								rms: 0.0,
						};
						this.periods = null
						this.correlations = null
				}

				// Autostart
				if (options.autoLoad) {
						this.loadAnalyser()
				}

				if(options.start){
						this.start();
				}
		}

		loadAnalyser() {
				if (this.isLoading) return
				this.isLoading = true

				let { context, options } = this
				let workerPath = options.workerPath || '/'
				let processorPath = workerPath + 'pitchdetectorworker.js'

				options.sampleRate = this.sampleRate

				return context.audioWorklet.addModule(processorPath)
						.then(() => {
								let analyser = new AudioWorkletNode(context, 'pitch-detector')

								analyser.port.onmessage = this.onAnalyserMessage
								analyser.port.postMessage({
										type: 'setOptions',
										payload: Object.assign({}, options, {
												onDebug: !!options.onDebug,
												onDetect: !!options.onDetect,
												onDestroy: null
										})
								})

								this.analyser = analyser
								if (options.start) this.start()
						});
		}

		onAnalyserMessage = (event) => {
				let { type, payload } = event.data
				switch (type) {
						case 'updateDebug':
								this.workerDebug(payload)
						case 'updateStats':
								return this.workerStats(payload)
				}
		}

		workerDebug(payload) {
				Object.assign(this.debug, payload.debug)
				this.periods = payload.periods
				this.correlations = payload.correlations
		}

		workerStats(payload) {
				Object.assign(this.stats, payload)
				this.stats.time = this.context.currentTime
		}

		start() {
				if (!this.analyser) return

				// Wait until input is defined (when waiting for microphone)
				if(this.input){
						this.input.connect(this.analyser);
						if(this.output){
								this.analyser.connect(this.output);
						} else {
								// webkit but, it requires an output....
								// var dummyOutput = this.context.createGain();
								// dummyOutput.gain.value= 0;
								// dummyOutput.connect(this.context.destination);
								const dummyOutput = this.context.createAnalyser();
								dummyOutput.fftSize = 32;
								this.analyser.connect(dummyOutput);
						}
				}
				if(!this.started){
						this.started = true;
						this.analyser.port.postMessage({ type: 'start' })
						requestAnimationFrame(this.update);
				}
		}

		update = (event) => {
				if(this.lastOnDetect !== this.stats.time){
						this.lastOnDetect = this.stats.time;
						if(this.options.onDetect){
								this.options.onDetect(this.stats,this);
						}
				}
				if(this.options.onDebug){
						this.options.onDebug(this.debug, this);
				}
				if(this.started === true){
						requestAnimationFrame(this.update);
				}
		}

		stop() {
				this.started = false;
		}

		// Free op resources
		//
		// Note: It's not tested if it actually frees up resources
		destroy() {
				this.stop();
				if(this.options.onDestroy){
						this.options.onDestroy();
				}
				if(this.input && this.input.stop){
						try {
								this.input.stop(0);
						} catch(e){}
				}
				if(this.input) this.input.disconnect();
				if(this.analyser) this.analyser.disconnect();
				this.input = null;
				this.analyser = null;
				this.context = null;
				this.buffer = null;
		}

		/**
		 * Sync methoc to retrieve latest pitch in various forms:
		 */

		getFrequency() {
				return this.stats.frequency;
		}

		getNoteNumber() {
				return frequencyToNote(this.stats.frequency);
		}

		getNoteString() {
				return frequencyToString(this.stats.frequency);
		}

		getPeriod() {
				return this.stats.best_period;
		}

		getCorrelation() {
				return this.stats.best_correlation;
		}

		getCorrelationIncrease() {
				return this.stats.best_correlation - this.stats.worst_correlation;
		}

		getDetune() {
				return centsOffFromPitch(this.stats.frequency, frequencyToNote(this.stats.frequency));
		}
}
