'use strict';

// Shared test helpers. Loaded both by the main test runner and by the
// worker threads, so it must not touch any worker-only API at load time.

var path = require('path');
var crypto = require('crypto');

var jsfx = require(path.join(__dirname, '..', 'jsfx.js'));
jsfx.SetSampleRate(22050);

// Sounds renderable through jsfx.RenderLibrary with the default module list.
var LIBRARY = Object.freeze({
	noise: Object.freeze({
		Generator: { Func: 'noise' },
		Volume: { Master: 0.5, Attack: 0.005, Sustain: 0.05, Decay: 0.2 }
	}),
	unoise: Object.freeze({
		Generator: { Func: 'unoise' },
		Volume: { Master: 0.5, Attack: 0.005, Sustain: 0.05, Decay: 0.15 }
	}),
	repeat: Object.freeze({
		Generator: { Func: 'square' },
		Frequency: { Start: 440, RepeatSpeed: 0.05 },
		Volume: { Master: 0.5, Attack: 0.01, Sustain: 0.05, Decay: 0.1 }
	}),
	phaser: Object.freeze({
		Generator: { Func: 'saw' },
		Phaser: { Offset: 0.4, Sweep: 0.2 },
		Volume: { Master: 0.4, Attack: 0.01, Sustain: 0.1, Decay: 0.2 }
	})
});

// Extra one-off sounds for unit tests with custom module lists.
var STRING_PARAMS = Object.freeze({
	Generator: { Func: 'string' },
	Frequency: { Start: 330, Slide: -0.1 },
	Volume: { Master: 0.5, Attack: 0.005, Sustain: 0.1, Decay: 0.3 }
});

var GUITAR_PARAMS = Object.freeze({
	Frequency: { Start: 220 },
	Volume: { Master: 0.8, Attack: 0.005, Sustain: 0.1, Decay: 0.4 }
});

var GUITAR_MODULES = Object.freeze([
	jsfx.Module.Frequency,
	jsfx.Module.Vibrato,
	jsfx.Module.Guitar,
	jsfx.Module.Volume
]);

var SEED = 'jsfx-determinism-seed-2026';

// Renders one sound synchronously on this thread and returns its samples.
function renderOne(name, seed, modules) {
	var params = LIBRARY[name];
	var processor = new jsfx.Processor(params, modules || jsfx.DefaultModules, { seed: seed });
	var block = new Float32Array(processor.getSamplesLeft());
	processor.generate(block);
	return { block: block, processor: processor, declaredLength: processor.declaredLength };
}

// Hash of the raw float samples, as transferred between threads.
function hashFloat(block) {
	var hash = crypto.createHash('sha256');
	hash.update(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
	return hash.digest('hex');
}

// Hash of the 16-bit PCM payload that would land in a WAV file.
function hashPCM16(block) {
	var bytes = new Uint8Array(block.length * 2);
	jsfx.Util.CopyFToU8(bytes, block);
	var hash = crypto.createHash('sha256');
	hash.update(Buffer.from(bytes.buffer));
	return hash.digest('hex');
}

// Mixes stems into one mono buffer, matching how overlapping sounds are
// summed by jsmusic.js.
function mixStems(stems) {
	var length = 0;
	Object.keys(stems).forEach(function(name) {
		length = Math.max(length, stems[name].length);
	});
	var mix = new Float32Array(length);
	Object.keys(stems).forEach(function(name) {
		var block = stems[name];
		for (var i = 0; i < block.length; i++) {
			mix[i] += block[i];
		}
	});
	return mix;
}

// Renders the whole library with a per-name child seed, mirroring
// jsfx.RenderLibrary's seed derivation.
function renderLibrarySeeded(seed, modulesByName) {
	var stems = {};
	var index = 0;
	Object.keys(LIBRARY).forEach(function(name) {
		var child = String(seed) + '::' + name + '#' + index;
		var modules = modulesByName && modulesByName[name];
		stems[name] = renderOne(name, child, modules).block;
		index += 1;
	});
	return stems;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error('assertion failed: ' + message);
	}
}

function assertEqual(actual, expected, message) {
	assert(actual === expected, message + ' (expected ' + expected + ', got ' + actual + ')');
}

module.exports = {
	jsfx: jsfx,
	LIBRARY: LIBRARY,
	STRING_PARAMS: STRING_PARAMS,
	GUITAR_PARAMS: GUITAR_PARAMS,
	GUITAR_MODULES: GUITAR_MODULES,
	SEED: SEED,
	renderOne: renderOne,
	hashFloat: hashFloat,
	hashPCM16: hashPCM16,
	mixStems: mixStems,
	renderLibrarySeeded: renderLibrarySeeded,
	assert: assert,
	assertEqual: assertEqual
};
