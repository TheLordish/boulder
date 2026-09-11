# Boulder

Food, body and training log. Runs as an installed web app on Android, stores
everything on the device, and calls Anthropic only when it genuinely has to.

## Screens

- **Today** rings, weight against goal, the entry form, today's meals
- **Calendar** month heat map plus a daily-calorie histogram
- **Body** Weight, Streak and Scan
- **Gym** Session, Trends and Plan
- **Ask** Chat and Read
- Settings, export, import and your API key live behind the gear

## Files

```
index.html              markup shell
css/app.css             all styling
js/icons.js             Lucide icons, inlined
js/store.js             localStorage, schema versioning, migrations
js/api.js               Anthropic calls, key vault, model tiers, error kinds
js/gym.js               split, muscle groups, sessions, lift history
js/comp.js              body composition scans
js/extras.js            saved-meal library, reminders
js/entry.js             structured add form and its resolution cascade
js/app.js               food, weight, streak, calendar, assistant
js/views2.js            gym, scan and streak-calendar rendering
js/shell.js             navigation, sub-panes, sheets, keyboard handling
js/main.js              boot order, key setup, service worker
sw.js                   offline shell cache
manifest.webmanifest    install metadata
icons/                  192, 512, maskable 512, plus a light-ground logo
```

Ten modules in `js/`, loaded in the order listed. `icons.js` must come first.

## How a food gets its numbers

Filled from the cheapest source that knows the answer, and nothing you typed is
ever overwritten:

1. the fields you filled in, free and instant
2. your own library, scaled to the amount, free and instant
3. Open Food Facts, one free network call
4. the model, and only for what is still blank

Everything you log joins the library automatically, stored per unit, so the
second time you eat it the name and an amount are enough.

## Model tiers

Logging, label reading, portion changes and gap-filling use the fast model
because you are waiting on them. The coach, the assistant and recipe generation
use the deeper one. Each tier remembers separately which model was accepted.

## Setup

1. Upload the contents of this folder to a public GitHub repository
2. Settings, Pages, deploy from `main`, folder `/ (root)`
3. Open the URL in Chrome on Android, menu, Add to home screen
4. Gear, Data and setup, paste your Anthropic API key, press Test it

The key is stored on the device only. It is not in the source and goes nowhere
except Anthropic.

## Updating

Paste the changed file into the GitHub web editor and commit. Every asset URL
carries a version query, so the new build lands on the next launch. If it ever
sticks, gear, Data and setup, About, Force update.

Your data is untouched by updates. It lives in browser storage, not in the repo.

## Schema

`store.js` holds a version number and a migration chain. Any change to the shape
of a stored record gets a migration, so an old record can never reach the app in
a shape it does not expect.
