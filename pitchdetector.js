
/*
The MIT License (MIT)

Copyright (c) 2014-2015 Chris Wilson, modified by Mark Marijnissen

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

(function(){
var noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteToFrequency( note ) {
	return 440 * Math.pow(2,(note-69)/12);
}

function noteToPeriod (note, sampleRate) {
	return sampleRate / noteToFrequency(note);
}

function frequencyToNote( frequency ) {
	var noteNum = 12 * (Math.log( frequency / 440 )/Math.log(2) );
	return Math.round( noteNum ) + 69;
}

function frequencyToString( frequency ){
	var note = frequencyToNote(frequency);
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
		}).then(function(stream){
			var liveInputNode = context.createMediaStreamSource(stream);
			callback(null, liveInputNode);
		}).catch(function(error){
			console.error('getUserMedia error', error);
			callback(error,null);
		});
	} catch(e) {
		console.error('getUserMedia exception', e);
		callback(e,null);
	}
}

// prefix fixes
var requestAnimationFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame;

function PitchDetector(options){

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
	this.update = this.update.bind(this); // update function (bound to this)
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
		var self = this;
		getLiveInput(this.context,function(err,input){
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

PitchDetector.prototype.setOptions = function(options,ignoreConstructorOnlyProperties){
	var self = this;

	// Override options (if defined)
	['minCorrelation','minCorrelationIncrease','minRms',
		'normalize','stopAfterDetection','interpolateFrequency',
		'workerPath', 'start', 'onDebug','onDetect','onDestroy'
	].forEach(function(option){
		if(typeof options[option] !== 'undefined') {
			self.options[option] = options[option];
		}
	});

	if(ignoreConstructorOnlyProperties !== true){
		// Warn if you're setting Constructor-only options!
		['input','output','length','context'].forEach(function(option){
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
};

PitchDetector.prototype.loadAnalyser = function() {
	if (this.isLoading) return
	this.isLoading = true

	let { context, options } = this
	let workerPath = options.workerPath || '/'
	let processorPath = workerPath + 'pitchdetectorworker.js'

	options.sampleRate = this.sampleRate

	return context.audioWorklet.addModule(processorPath)
		.then(function () {
			let analyser = new AudioWorkletNode(context, 'pitch-detector')

			analyser.port.onmessage = this.onAnalyserMessage.bind(this)
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
		}.bind(this))
}

PitchDetector.prototype.onAnalyserMessage = function (event) {
	let { type, payload } = event.data
	switch (type) {
		case 'updateDebug':
			this.workerDebug(payload)
		case 'updateStats':
			return this.workerStats(payload)
	}
}

PitchDetector.prototype.workerDebug = function (payload) {
	Object.assign(this.debug, payload.debug)
	this.periods = payload.periods
	this.correlations = payload.correlations
}

PitchDetector.prototype.workerStats = function (payload) {
	Object.assign(this.stats, payload)
	this.stats.time = this.context.currentTime
}

PitchDetector.prototype.start = function(){
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
			var dummyOutput = this.context.createAnalyser();
			dummyOutput.fftSize = 32;
			this.analyser.connect(dummyOutput);
		}
	}
	if(!this.started){
		this.started = true;
		this.analyser.port.postMessage({ type: 'start' })
		requestAnimationFrame(this.update);
	}
};

PitchDetector.prototype.update = function(event){
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
};

PitchDetector.prototype.stop = function(){
	this.started = false;
};

// Free op resources
//
// Note: It's not tested if it actually frees up resources
PitchDetector.prototype.destroy = function(){
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
};

/**
 * Sync methoc to retrieve latest pitch in various forms:
 */

PitchDetector.prototype.getFrequency = function(){
	return this.stats.frequency;
};

PitchDetector.prototype.getNoteNumber = function(){
	return frequencyToNote(this.stats.frequency);
};

PitchDetector.prototype.getNoteString = function(){
	return frequencyToString(this.stats.frequency);
};

PitchDetector.prototype.getPeriod = function(){
	return this.stats.best_period;
};

PitchDetector.prototype.getCorrelation = function(){
	return this.stats.best_correlation;
};

PitchDetector.prototype.getCorrelationIncrease = function(){
	return this.stats.best_correlation - this.stats.worst_correlation;
};

PitchDetector.prototype.getDetune = function(){
	return centsOffFromPitch(this.stats.frequency, frequencyToNote(this.stats.frequency));
};

// Export on Window or as CommonJS module
if(typeof module !== 'undefined') {
	module.exports = PitchDetector;
} else {
	window.PitchDetector = PitchDetector;
}
})();
