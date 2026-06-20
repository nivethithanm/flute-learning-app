# Kuzhal — bamboo flute learning companion

A lightweight, dependency-free web app for learning the bamboo flute across the
**Carnatic** and **Hindustani** traditions. Two files, no framework, no build step.

**Live site:** https://nivethithanm.github.io/flute-learning-app/

## Sections

- **Basics** — posture, breath, your first clear tone, choosing a flute.
- **Sound & waves** — how a column of air becomes a pitch, with an interactive standing-wave model.
- **Sound travel** — frequency, wavelength and effective tube length for each swara.
- **Notation & fingering** — the twelve swaras in both traditions, a bansuri (6-hole) **and** Carnatic venu (8-hole) fingering chart, and an *Explore each swara* panel that shows the fingering and an animated sound wave for every note.
- **Scales & keys** — what a flute's key means and the exact frequency of every swara.
- **Ragas** — ascent, descent and mood for eleven ragas you can hear.
- **Songs & practice** — sarali/janta/datu varisai, alankara, public-domain melodies, and a personal notebook (saved in your browser).
- **Tuner** — microphone pitch detection that names the swara (Carnatic *or* Hindustani naming), shows how in-tune you are, displays the estimated fingering, and transcribes the notes you play.

## Running locally

Most of the app works by simply opening `index.html`. The **tuner and transcription**
use the microphone, which browsers only allow on a secure origin (`https`) or
`localhost` — not from a `file://` page. To use those, run a tiny local server:

```bash
python3 -m http.server
# then open http://localhost:8000/
```

## Tech

Vanilla HTML, CSS and JavaScript. Sound synthesis and pitch detection use the
Web Audio API (autocorrelation for the tuner). All reference data — ragas,
fingerings, scales, songs — lives in plain arrays near the top of `app.js`, so
it's easy to extend.

## Notes

Fingering charts follow common standards; komal/tivra notes use half-holing and
exact layouts vary by flute and maker — follow your teacher's chart where it
differs. Copyrighted film-song notations are intentionally not included; the
notebook and tuner let you capture and learn any tune yourself.
