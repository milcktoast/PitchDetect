class PitchDetectorWorker extends AudioWorkletProcessor {
	constructor () {
		super()

		this.debug = {}
		this.stats = {}

		this.options = {
			sampleRate: 0
		}
		this.bufferState = {
			fillIndex: 0,
			buffer: null
		}
		this.state = {
			MAX_SAMPLES: 0,
			isStarted: false,
			periods: [],
			correlations: [],
		}

		this.port.onmessage = this.onPortMessage
	}

	onPortMessage = (event) => {
		switch (event.data.type) {
			case 'setOptions':
				return this.setOptions(event.data.payload)
			case 'start':
				return this.start()
			case 'stop':
				return this.stop()
		}
	}

	setOptions (options) {
		this.options = options
		this.updateBufferState(options)
		this.updateCorrelations(options)
		this.updatePeriods(options)
	}

	updateBufferState (options) {
		let { bufferState } = this
		bufferState.buffer = new Float32Array(options.length)
	}

	updateCorrelations (options) {
		let { state } = this
		state.MAX_SAMPLES = Math.floor(options.length / 2)
		state.correlations = new Array(state.MAX_SAMPLES)
	}

	updatePeriods (options) {
		let { state, bufferState } = this
		let { sampleRate } = options
		let { MAX_SAMPLES } = state

		// Set frequency domain (i.e. min-max period to detect frequencies on)
		let minPeriod = options.minPeriod || 2
		let maxPeriod = options.maxPeriod || MAX_SAMPLES

		if (options.note) {
			let period = Math.round(noteToPeriod(options.note, sampleRate))
			minPeriod = period
			maxPeriod = period
		}

		if (options.minNote) {
			maxPeriod = Math.round(noteToPeriod(options.minNote, sampleRate))
		}
		if (options.maxNote) {
			minPeriod = Math.round(noteToPeriod(options.maxNote, sampleRate))
		}
		if (options.minFrequency) {
			maxPeriod = Math.floor(sampleRate / options.minFrequency)
		}
		if (options.maxFrequency) {
			minPeriod = Math.ceil(sampleRate / options.maxFrequency)
		}

		if (options.periods) {
			state.periods = options.periods
		} else {
			let periods = state.periods = []
			if (maxPeriod < minPeriod) {
				let tmp = maxPeriod
				maxPeriod = minPeriod
				minPeriod = tmp
			}

			let range = [1, 1]
			if (options.minCorrelation) {
				range = [1, 1]
			} else if (options.minCorrelationIncrease) {
				range = [10, 1]
			}

			if (maxPeriod - minPeriod < 1 + range[0] + range[1]) {
				minPeriod = Math.floor(minPeriod - range[0])
				maxPeriod = Math.ceil(maxPeriod + range[1])
			}

			maxPeriod = Math.min(maxPeriod, MAX_SAMPLES)
			minPeriod = Math.max(2, minPeriod)
			options.minPeriod = minPeriod
			options.maxPeriod = maxPeriod

			for (let i = minPeriod; i <= maxPeriod; i++) {
				periods.push(i)
			}
		}
	}

	start () {
		this.state.isStarted = true
	}

	stop () {
		this.state.isStarted = false
	}

	process (inputList, outputList, parameters) {
		let buffer = this.fillBuffer(inputList)
		if (buffer) {
			let res = this.autoCorrelate(buffer)
		}
		return true
	}

	fillBuffer (inputList) {
		let { bufferState } = this
		let input = inputList[0][0]

		bufferState.buffer.set(input, bufferState.fillIndex)
		bufferState.fillIndex += input.length

		if (bufferState.fillIndex >= bufferState.buffer.length - 1) {
			bufferState.fillIndex = 0
			return bufferState.buffer
		}
	}

	autoCorrelate (buffer) {
		let { options, state, debug, stats } = this
		if (!state.isStarted || buffer.length === 0) return

		// Keep track of best period/correlation
		let best_period = 0
		let best_correlation = 0

		// Keep track of local minima (i.e. nearby low correlation)
		let worst_period = 0
		let worst_correlation = 1

		// Remember previous correlation to determine if
		// we're ascending (i.e. getting near a frequency in the signal)
		// or descending (i.e. moving away from a frequency in the signal)
		let last_correlation = 1

		// iterators
		let i = 0; // for the different periods we're checking
		let j = 0; // for the different "windows" we're checking
		let period = 0; // current period we're checking.

		// calculated stuff
		let rms = 0
		let correlation = 0
		let peak = 0

		// early stop algorithm
		let found_pitch = !options.minCorrelationIncrease && !options.minCorrelation
		let find_local_maximum = options.minCorrelationIncrease

		let { sampleRate } = options
		let { periods, correlations } = state

		// Constants
		let NORMALIZE = 1
		let BUFFER_LENGTH = buffer.length
		let PERIOD_LENGTH = periods.length
		let MAX_SAMPLES = state.MAX_SAMPLES

		// Check if there is enough signal
		for (i = 0; i < BUFFER_LENGTH; i++) {
			rms += buffer[i]*buffer[i]
			// determine peak volume
			if (buffer[i] > peak) peak = buffer[i]
		}
		rms = Math.sqrt(rms / BUFFER_LENGTH)

		// Abort if not enough signal
		if (rms < options.minRms) {
			return false
		}

		// Normalize (if configured)
		if (options.normalize === 'rms') {
			NORMALIZE = 2 * rms
		} else if (options.normalize === 'peak') {
			NORMALIZE = peak
		}

		/**
		 *  Test different periods (i.e. frequencies)
		 *
		 *  Buffer: |----------------------------------------| (1024)
		 *  i:      |    					1      44.1 kHz
		 *  		||                      2      22.05 kHz
		 *  		|-|                     3      14.7 kHz
		 *  		|--|                    4      11 kHz
		 *          ...
		 *          |-------------------|   512    86hz
		 *
		 *
		 *  frequency = sampleRate / period
		 *  period = sampleRate / frequency
		 *
		 *
		 */
		for (i = 0; i < PERIOD_LENGTH; i++) {
			period = periods[i]
			correlation = 0

			/**
			 *
			 * Sum all differences
			 *
			 * Version 1: Use absolute difference
			 * Version 2: Use squared difference.
			 *
			 * Version 2 exagerates differences, which is a good property.
			 * So we'll use version 2.
			 *
			 *  Buffer: |-------------------|--------------------| (1024)
			 *  j:
			 *  		|---|                        0
			 *  		 |---|                       1
			 *  		  |---|                      2
			 *  		    ...
			 *  		                     |---|   512
			 *
			 *  sum-of-differences
			 */
			for (j = 0; j < MAX_SAMPLES; j++) {
				// Version 1: Absolute values
				correlation += Math.abs((buffer[j])-(buffer[j+period])) / NORMALIZE

				// Version 2: Squared values (exagarates difference, works better)
				//correlation += Math.pow((buffer[j]-buffer[j+period]) / NORMALIZE,2)
			}

			// Version 1: Absolute values
			correlation = 1 - (correlation/MAX_SAMPLES)

			// Version 2: Squared values
			//correlation = 1 - Math.sqrt(correlation/MAX_SAMPLES)

			// Save Correlation
			correlations[period] = correlation

			// We're descending (i.e. moving towards frequencies that are NOT in here)
			if (last_correlation > correlation) {

				// We already found a good correlation, so early stop!
				if (options.minCorrelation && best_correlation > options.minCorrelation) {
					found_pitch = true
					break
				}

				// We already found a good correlationIncrease, so early stop!
				if (options.minCorrelationIncrease &&
					best_correlation - worst_correlation > options.minCorrelationIncrease
				) {
					found_pitch = true
					break
				}

				// Save the worst correlation of the latest descend (local minima)
				worst_correlation = correlation
				worst_period = period

				// we're ascending, and found a new high!
			} else if (find_local_maximum || correlation > best_correlation) {
				best_correlation = correlation
				best_period = period
			}

			last_correlation = correlation
		}

		if (best_correlation > 0.01 && found_pitch) {
			stats.detected = true
			stats.best_period = best_period
			stats.worst_period = worst_period
			stats.best_correlation = best_correlation
			stats.worst_correlation = worst_correlation
			// stats.time = this.context.currentTime
			stats.rms = rms

			let shift = 0
			if (options.interpolateFrequency &&
				i >= 3 && period >= best_period + 1 &&
				correlations[best_period+1] &&
				correlations[best_period-1]
			) {
				// Now we need to tweak the period - by interpolating between the values to the left and right of the
				// best period, and shifting it a bit.  This is complex, and HACKY in this code (happy to take PRs!) -
				// we need to do a curve fit on correlations[] around best_period in order to better determine precise
				// (anti-aliased) period.

				// we know best_period >=1,
				// since found_pitch cannot go to true until the second pass (period=1), and
				// we can't drop into this clause until the following pass (else if).
				shift = (correlations[best_period+1] - correlations[best_period-1]) / best_correlation
				shift = shift * 8
			}
			stats.frequency = sampleRate/(best_period + shift)

			if (options.onDebug) {
				debug.frequency = stats.frequency
			}

			if (options.stopAfterDetection) {
				state.isStarted = false
			}

			this.port.postMessage({
				type: 'updateStats',
				payload: stats
			})
		}

		if (options.onDebug) {
			debug.detected = stats.detected
			debug.rms = rms
			// debug.time = this.context.currentTime
			debug.best_period = best_period
			debug.worst_period = worst_period
			debug.best_correlation = best_correlation
			debug.worst_correlation = worst_correlation
			debug.frequency = best_period > 0? sampleRate/best_period: 0

			this.port.postMessage({
				type: 'updateDebug',
				payload: { debug, periods, correlations }
			})
		}

		return stats.detected
	}
}

function noteToFrequency( note ) {
	return 440 * Math.pow(2,(note-69)/12);
}

function noteToPeriod (note, sampleRate) {
	return sampleRate / noteToFrequency(note);
}

registerProcessor('pitch-detector', PitchDetectorWorker)