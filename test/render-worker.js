'use strict';

// Worker thread: renders one whole sound library from a seed and reports
// per-stem and mix hashes. Three copies of this worker running at the same
// time model parallel synthesis with a shared seed.

var workerThreads = require('worker_threads');
var helpers = require('./helpers');

var jsfx = helpers.jsfx;

workerThreads.parentPort.on('message', function(message) {
	jsfx.RenderLibrary(message.library, {
		seed: message.seed,
		chunk: message.chunk || 512
	}).then(function(stems) {
		var stemHashes = {};
		var lengths = {};
		Object.keys(stems).forEach(function(name) {
			stemHashes[name] = helpers.hashFloat(stems[name]);
			lengths[name] = stems[name].length;
		});
		var mix = helpers.mixStems(stems);
		workerThreads.parentPort.postMessage({
			ok: true,
			stemHashes: stemHashes,
			lengths: lengths,
			mixHash: helpers.hashFloat(mix),
			mixPCMHash: helpers.hashPCM16(mix)
		});
	}).catch(function(err) {
		workerThreads.parentPort.postMessage({ ok: false, error: String(err && err.stack || err) });
	});
});
