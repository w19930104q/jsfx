![](https://raw.githubusercontent.com/loov/jsfx/master/jsfx.png)

This is a JavaScript library for sound effect generation and is supported on
[most current browsers](http://caniuse.com/#feat=audio).

Generation speed is approximately 1s audio = 10ms processing. Of course that
value can vary a lot, depending on the settings or browser that you use.

### How to use it?

Open [index.html](http://loov.github.io/jsfx/) - this helps to pick out your samples.

Try clicking the presets and tweaking all the options. Once you are satisified
with your result click add button at top-right.

Enter a name for the sound e.g. "select", repeat that as many times as you like. Tip: You can save your settings by making a bookmark of the page.

At the bottom of the page there is a Library section. There you can relisten
or remove sounds that you do not like.

Once you are satisfied with your selection copy the JSON description
(it's inside the input box).

It will look something like:

    {"select":{"Volume":{"Sustain":0.1,"Decay":0.15,"Punch":0.55}}}

To use that library, you need to include `jsfx.js` in your code and use `jsfx.Sounds(libarry)` to initialize it. For example:

```html
<script src="jsfx.js"></script>
<script>
var library = {
	"select": {"Volume":{"Sustain":0.1,"Decay":0.15,"Punch":0.55}},
	"long": {"Volume":{"Sustain":0.1,"Decay":0.5,"Punch":1}}
};
var sfx = jsfx.Sounds(library);
</script>
<button onclick="sfx.select()">Select</button>
<button onclick="sfx.long()">Long</button>
```

Note that it will load with a delay to avoid blocking the page load for too
long, so calling those function immediately may result in silence.

### Using with AudioContext (experimental)

You can use AudioContext to procedurally generate the sounds, for example:

```html
<script src="jsfx.js"></script>
<script>
var library = {
	"static": {"Volume":{"Sustain":0.1,"Decay":0.15,"Punch":0.55}},
	"dynamic": function(){
		return {"Frequency": { "Start": Math.random()*440 + 220 }};
	},
	"coin": jsfx.Preset.Coin
};
var sfx = jsfx.Live(library);
</script>
<button onclick="sfx.static()">Static</button>
<button onclick="sfx.dynamic()">Dynamic</button>
<button onclick="sfx.coin()">Coin</button>
```

### Reproducible and parallel rendering

Every render owns its random source, envelopes and scratch buffers, so two
renders never share mutable state. Pass a `seed` in the options to make noise,
the Karplus-Strong buffers and preset randomization reproducible:

```js
// options may be { seed: ... } or a bare seed value
var block = jsfx.FloatBuffer(params, jsfx.DefaultModules, { seed: 42 });
```

`jsfx.RenderLibrary(library, options)` renders a whole library into
`Float32Array` buffers without touching any browser audio API, which makes it
usable in Node and in Web Workers. Each sound is derived from one top-level
seed; rendering the same library with the same seed always produces the same
samples, including for renders running in parallel. It supports cooperative
cancellation through an `AbortSignal` and releases every render context on
completion or abort:

```js
var controller = new AbortController();
jsfx.RenderLibrary(library, {
	seed: "level-1",
	chunk: 2048,
	signal: controller.signal,
	onprogress: function(name, done, total) { /* ... */ }
}).then(function(stems) {
	// stems is { name: Float32Array }
});

controller.abort(); // rejects with an AbortError and leaves no temp state
```

### Few notes...

It's recommended to copy the jsfx.js to your own project instead of
automatically downloading the latest version. Since every slight adjustment
to the audio generation code can affect the resulting audio significantly.

The stable API is what is described in the README, everything else is
subject to change.

### Thanks to

This project was inspired by [sfxr](http://www.drpetter.se/project_sfxr.html)
and was used as a reference for some algorithms and modes.