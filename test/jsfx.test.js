'use strict';

var path = require('path');
var workerThreads = require('worker_threads');
var helpers = require('./helpers');

var jsfx = helpers.jsfx;
var assert = helpers.assert;
var assertEqual = helpers.assertEqual;
var LIBRARY = helpers.LIBRARY;
var SEED = helpers.SEED;

var passed = 0;
function test(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(function() {
			passed += 1;
			console.log('  ok - ' + name);
		});
}

// ---------------------------------------------------------------------------
// 1. Seeded renders are deterministic inside one thread, for every random
//    source and the stateful generator/module buffers.
// ---------------------------------------------------------------------------
function testDeterminism() {
	return test('same seed reproduces noise/unoise/repeat/phaser samples', function() {
		Object.keys(LIBRARY).forEach(function(name) {
			var a = helpers.renderOne(name, SEED).block;
			var b = helpers.renderOne(name, SEED).block;
			assertEqual(a.length, b.length, name + ' length');
			assertEqual(helpers.hashFloat(a), helpers.hashFloat(b), name + ' float hash');
			assertEqual(helpers.hashPCM16(a), helpers.hashPCM16(b), name + ' pcm16 hash');
		});
	});
}

function testStringAndGuitarDeterminism() {
	return test('string and guitar scratch buffers are per-context and seeded', function() {
		// string uses the default module list but a custom generator object
		var sp1 = new jsfx.Processor(helpers.STRING_PARAMS, jsfx.DefaultModules, { seed: SEED });
		var sb1 = new Float32Array(sp1.getSamplesLeft());
		sp1.generate(sb1);
		var sp2 = new jsfx.Processor(helpers.STRING_PARAMS, jsfx.DefaultModules, { seed: SEED });
		var sb2 = new Float32Array(sp2.getSamplesLeft());
		sp2.generate(sb2);
		assertEqual(helpers.hashFloat(sb1), helpers.hashFloat(sb2), 'string reproducibility');
		assert(sb1.some(function(v) { return v !== 0; }), 'string produced signal');

		var gp1 = new jsfx.Processor(helpers.GUITAR_PARAMS, helpers.GUITAR_MODULES, { seed: SEED });
		var gb1 = new Float32Array(gp1.getSamplesLeft());
		gp1.generate(gb1);
		var gp2 = new jsfx.Processor(helpers.GUITAR_PARAMS, helpers.GUITAR_MODULES, { seed: SEED });
		var gb2 = new Float32Array(gp2.getSamplesLeft());
		gp2.generate(gb2);
		assertEqual(helpers.hashFloat(gb1), helpers.hashFloat(gb2), 'guitar reproducibility');

		// two processors alive at the same time with the same seed must not
		// share buffers or interfere with each other
		var parallelA = new jsfx.Processor(helpers.GUITAR_PARAMS, helpers.GUITAR_MODULES, { seed: SEED });
		var parallelB = new jsfx.Processor(helpers.GUITAR_PARAMS, helpers.GUITAR_MODULES, { seed: SEED });
		assert(parallelA.state.guitarBuffer !== parallelB.state.guitarBuffer,
			'guitar buffers are isolated per context');
		var pa = new Float32Array(parallelA.getSamplesLeft());
		var pb = new Float32Array(parallelB.getSamplesLeft());
		parallelA.generate(pa);
		parallelB.generate(pb);
		assertEqual(helpers.hashFloat(pa), helpers.hashFloat(pb), 'parallel guitar contexts match');
	});
}

function testDifferentSeedsDiffer() {
	return test('different seeds produce different noise', function() {
		var a = helpers.renderOne('noise', SEED).block;
		var b = helpers.renderOne('noise', SEED + '-other').block;
		assert(helpers.hashFloat(a) !== helpers.hashFloat(b), 'noise hashes must differ');
	});
}

// ---------------------------------------------------------------------------
// 2. Declared length and tail padding contract.
// ---------------------------------------------------------------------------
function testDeclaredLength() {
	return test('output length equals declared length, including repeat tail', function() {
		Object.keys(LIBRARY).forEach(function(name) {
			var r = helpers.renderOne(name, SEED);
			assertEqual(r.block.length, r.declaredLength, name + ' block vs declared length');
			// envelope-driven sounds must keep signal up to the final frame;
			// the old off-by-one dropped the last frames on RepeatSpeed.
			assert(r.block[r.block.length - 1] !== 0, name + ' last frame is not padding');
			// all envelope stages have been consumed by the end of the render
			assertEqual(r.processor.getSamplesLeft(), 0, name + ' envelopes fully consumed');
			// any further generate call can only emit silence
			var extra = new Float32Array(16);
			r.processor.generate(extra);
			assert(extra.every(function(v) { return v === 0; }), name + ' post-render is silence');
		});
	});
}

function testChunkedRenderingSameLength() {
	return test('chunked streaming render equals one-shot render and length', function() {
		var oneShot = helpers.renderOne('repeat', SEED).block;

		var processor = new jsfx.Processor(LIBRARY.repeat, jsfx.DefaultModules, { seed: SEED });
		var declared = processor.getSamplesLeft();
		var assembled = new Float32Array(declared);
		var chunkSize = 37; // deliberately awkward, unaligned size
		for (var offset = 0; offset < declared; offset += chunkSize) {
			var part = assembled.subarray(offset, Math.min(offset + chunkSize, declared));
			processor.generate(part);
		}
		assertEqual(assembled.length, declared, 'chunked length');
		assertEqual(helpers.hashFloat(assembled), helpers.hashFloat(oneShot),
			'chunked render matches one-shot render');
		assertEqual(processor.getSamplesLeft(), 0, 'chunked render consumes all envelopes');
	});
}

// ---------------------------------------------------------------------------
// 3. Parallel render in worker threads: three groups, same seed.
// ---------------------------------------------------------------------------
function runWorker() {
	return new Promise(function(resolve, reject) {
		var worker = new workerThreads.Worker(path.join(__dirname, 'render-worker.js'));
		worker.on('message', function(message) {
			worker.terminate();
			if (message.ok) {
				resolve(message);
			} else {
				reject(new Error(message.error));
			}
		});
		worker.on('error', reject);
		worker.postMessage({ library: LIBRARY, seed: SEED, chunk: 512 });
	});
}

function testParallelWorkers() {
	return test('three parallel worker groups: identical stem and mix hashes', function() {
		var groups = [runWorker(), runWorker(), runWorker()];
		return Promise.all(groups).then(function(results) {
			var reference = results[0];
			results.forEach(function(result, groupIndex) {
				Object.keys(LIBRARY).forEach(function(name) {
					assertEqual(result.stemHashes[name], reference.stemHashes[name],
						'group ' + groupIndex + ' stem ' + name);
					assertEqual(result.lengths[name], reference.lengths[name],
						'group ' + groupIndex + ' length ' + name);
				});
				assertEqual(result.mixHash, reference.mixHash, 'group ' + groupIndex + ' mix hash');
				assertEqual(result.mixPCMHash, reference.mixPCMHash,
					'group ' + groupIndex + ' pcm16 mix hash');
			});

			// worker output must match a sequential render on the main thread
			var sequentialStems = helpers.renderLibrarySeeded(SEED);
			Object.keys(LIBRARY).forEach(function(name, index) {
				var childSeed = String(SEED) + '::' + name + '#' + index;
				var expected = helpers.renderOne(name, childSeed).block;
				assertEqual(helpers.hashFloat(sequentialStems[name]), helpers.hashFloat(expected),
					'sequential child-seed render ' + name);
				assertEqual(reference.stemHashes[name], helpers.hashFloat(expected),
					'worker stem matches main-thread stem ' + name);
			});
			var sequentialMix = helpers.mixStems(sequentialStems);
			assertEqual(reference.mixHash, helpers.hashFloat(sequentialMix),
				'worker mix matches main-thread mix');
		});
	});
}

// ---------------------------------------------------------------------------
// 4. Cancellation: aborted renders leave no reusable temporary state.
// ---------------------------------------------------------------------------
function testAbortRejects() {
	return test('aborted RenderLibrary rejects with AbortError', function() {
		var controller = new AbortController();
		var promise = jsfx.RenderLibrary(LIBRARY, {
			seed: SEED,
			chunk: 64,
			signal: controller.signal
		});
		controller.abort();
		return promise.then(
			function() { throw new Error('aborted render should not resolve'); },
			function(err) { assertEqual(err.name, 'AbortError', 'error name'); }
		);
	});
}

function testAbortMidRenderCleanup() {
	return test('cancelled processor is closed and holds no reusable state', function() {
		// Simulate a render being cancelled halfway through its chunked
		// pumping, exactly what RenderLibrary does on an abort signal.
		var processor = new jsfx.Processor(LIBRARY.repeat, jsfx.DefaultModules, { seed: SEED });
		var declared = processor.getSamplesLeft();
		assert(declared > 64, 'sound is long enough to interrupt');

		var partial = new Float32Array(32);
		processor.generate(partial);
		assert(!processor.closed, 'processor alive before cancellation');
		assert(processor.state.envelopes.length > 0, 'envelope state exists mid-render');
		assert(processor.state.random, 'rng state exists mid-render');

		// cancellation drops every scratch buffer of the render context
		processor.close();
		assert(processor.closed, 'closed flag set');
		assertEqual(processor.modules.length, 0, 'modules dropped');
		assertEqual(processor.state, null, 'state dropped');
		assert(processor.finished, 'finished flag set');

		// the closed context refuses to generate again: no temporary state
		// can be revived or reused by a later sound
		var threw = false;
		try {
			processor.generate(new Float32Array(8));
		} catch (e) {
			threw = true;
		}
		assert(threw, 'generate on closed context throws');

		// a brand-new context with the same seed still renders the full
		// sound, proving the cancellation leaked nothing into later renders
		var fresh = new jsfx.Processor(LIBRARY.repeat, jsfx.DefaultModules, { seed: SEED });
		var full = new Float32Array(fresh.getSamplesLeft());
		fresh.generate(full);
		var expected = helpers.renderOne('repeat', SEED).block;
		assertEqual(full.length, expected.length, 'fresh render length unaffected');
		assertEqual(helpers.hashFloat(full), helpers.hashFloat(expected),
			'fresh render after cancellation is still reproducible');
	});
}

function testCloseReleasesScratch() {
	return test('close() releases every per-context scratch buffer', function() {
		var processor = new jsfx.Processor(helpers.GUITAR_PARAMS, helpers.GUITAR_MODULES, { seed: SEED });
		assert(processor.state.guitarBuffer instanceof Float32Array, 'guitar buffer allocated');
		assert(typeof processor.state.random === 'function', 'context rng present');
		assert(processor.state.envelopes.length > 0, 'envelopes present');
		processor.close();
		assertEqual(processor.state, null, 'state nulled');
		assert(processor.closed, 'closed flag set');
		assert(processor.finished, 'finished flag set');
		// close is idempotent
		processor.close();
	});
}

function testRerenderAfterCancellation() {
	return test('fresh render after a cancelled one reproduces the seed exactly', function() {
		var controller = new AbortController();
		var cancelled = jsfx.RenderLibrary(LIBRARY, { seed: SEED, chunk: 32, signal: controller.signal });
		controller.abort();
		return cancelled.catch(function() {
			return jsfx.RenderLibrary(LIBRARY, { seed: SEED, chunk: 512 });
		}).then(function(stems) {
			var expected = helpers.renderLibrarySeeded(SEED);
			Object.keys(LIBRARY).forEach(function(name) {
				assertEqual(helpers.hashFloat(stems[name]), helpers.hashFloat(expected[name]),
					'post-cancel render ' + name);
			});
		});
	});
}

// ---------------------------------------------------------------------------
// 5. RNG primitive and preset determinism.
// ---------------------------------------------------------------------------
function testRNGPrimitive() {
	return test('createRNG is deterministic, well distributed and seed-isolated', function() {
		var a = jsfx.Util.createRNG(42);
		var b = jsfx.Util.createRNG(42);
		var c = jsfx.Util.createRNG(43);
		var seqA = [];
		var sum = 0;
		for (var i = 0; i < 10000; i++) {
			var v = a();
			seqA.push(v);
			sum += v;
			assert(v >= 0 && v < 1, 'rng output in [0,1)');
		}
		for (var j = 0; j < 10000; j++) {
			assertEqual(b(), seqA[j], 'same seed sequence at index ' + j);
		}
		assert(c() !== seqA[0], 'different seed diverges immediately');
		var mean = sum / 10000;
		assert(Math.abs(mean - 0.5) < 0.02, 'rng mean near 0.5 (got ' + mean + ')');
		// string and number seeds must not throw
		jsfx.Util.createRNG('string-seed')();
	});
}

function testPresetSeeded() {
	return test('presets accept a seeded rng and stay reproducible', function() {
		var rng1 = jsfx.Util.createRNG(SEED);
		var rng2 = jsfx.Util.createRNG(SEED);
		var names = ['Coin', 'Laser', 'Explosion', 'Powerup', 'Hit', 'Jump', 'Select', 'Lucky'];
		names.forEach(function(name) {
			var p1 = jsfx.Preset[name](rng1);
			var p2 = jsfx.Preset[name](rng2);
			assertEqual(JSON.stringify(p1), JSON.stringify(p2), 'preset ' + name + ' reproducible');

			// and the preset output rendered with a render seed is reproducible
			var pr1 = new jsfx.Processor(p1, jsfx.DefaultModules, { seed: SEED + name });
			var pr2 = new jsfx.Processor(p2, jsfx.DefaultModules, { seed: SEED + name });
			var b1 = new Float32Array(pr1.getSamplesLeft());
			var b2 = new Float32Array(pr2.getSamplesLeft());
			pr1.generate(b1);
			pr2.generate(b2);
			assertEqual(helpers.hashFloat(b1), helpers.hashFloat(b2), 'preset render ' + name);
		});
		// backward compatibility: zero-argument presets still work
		assert(typeof jsfx.Preset.Coin().Frequency.Start === 'number', 'legacy preset call works');
	});
}

function testParamsFunctionSeeded() {
	return test('params function receives the context rng', function() {
		var seen = [];
		var paramsFn = function(rng) {
			seen.push(rng);
			return { Frequency: { Start: 220 + rng() * 220 } };
		};
		var p1 = new jsfx.Processor(paramsFn, jsfx.DefaultModules, { seed: SEED });
		var p2 = new jsfx.Processor(paramsFn, jsfx.DefaultModules, { seed: SEED });
		assertEqual(seen.length, 2, 'rng passed twice');
		assert(seen[0] !== seen[1], 'each context gets its own rng instance');
		var b1 = new Float32Array(p1.getSamplesLeft());
		var b2 = new Float32Array(p2.getSamplesLeft());
		p1.generate(b1);
		p2.generate(b2);
		assertEqual(helpers.hashFloat(b1), helpers.hashFloat(b2), 'function params reproducible');
	});
}

function testRenderLibraryLifecycle() {
	return test('RenderLibrary closes every processor on completion and abort', function() {
		var closed = [];
		var originalClose = jsfx.Processor.prototype.close;
		jsfx.Processor.prototype.close = function() {
			closed.push(this);
			return originalClose.apply(this, arguments);
		};

		// normal completion: one close() per sound
		var completed = jsfx.RenderLibrary(LIBRARY, { seed: SEED, chunk: 256 })
			.then(function(stems) {
				assertEqual(closed.length, Object.keys(LIBRARY).length,
					'every completed processor is closed');
				closed.forEach(function(processor) {
					assert(processor.closed, 'completed processor closed');
				});
				assertEqual(Object.keys(stems).length, Object.keys(LIBRARY).length,
					'all stems returned');
			});

		return completed.then(function() {
			// abort path: the in-flight processor is closed as well
			closed.length = 0;
			var controller = new AbortController();
			var promise = jsfx.RenderLibrary(LIBRARY, {
				seed: SEED,
				chunk: 16,
				signal: controller.signal
			});
			setTimeout(function() { controller.abort(); }, 5);
			return promise.then(
				function() { throw new Error('aborted render should not resolve'); },
				function(err) {
					jsfx.Processor.prototype.close = originalClose;
					assertEqual(err.name, 'AbortError', 'abort error name');
					assert(closed.length >= 1, 'in-flight processor closed on abort');
					closed.forEach(function(processor) {
						assertEqual(processor.state, null, 'aborted processor state dropped');
					});
				}
			);
		}).catch(function(err) {
			jsfx.Processor.prototype.close = originalClose;
			throw err;
		});
	});
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
testDeterminism()
	.then(testStringAndGuitarDeterminism)
	.then(testDifferentSeedsDiffer)
	.then(testDeclaredLength)
	.then(testChunkedRenderingSameLength)
	.then(testParallelWorkers)
	.then(testAbortRejects)
	.then(testAbortMidRenderCleanup)
	.then(testCloseReleasesScratch)
	.then(testRerenderAfterCancellation)
	.then(testRenderLibraryLifecycle)
	.then(testRNGPrimitive)
	.then(testPresetSeeded)
	.then(testParamsFunctionSeeded)
	.then(function() {
		console.log('\nAll ' + passed + ' test groups passed.');
	})
	.catch(function(err) {
		console.error('\nTEST FAILURE');
		console.error(err && err.stack || err);
		process.exit(1);
	});
