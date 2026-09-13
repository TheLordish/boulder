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

## The food database

`data/regional.json` ships with the app: Levantine, Gulf and Mediterranean
staples that no public dataset covers. These are reference estimates rather than
lab measurements.

`data/foods.json` is built by the **Build food database** workflow, which
downloads the USDA FoodData Central release, strips 150 nutrients down to the
four Boulder uses, and commits the result. USDA SR Legacy is public domain and
lab-derived, and is the set most other food databases are built from. GitHub's
runners can reach USDA, so you never download anything yourself.

Run that workflow once. It takes a few minutes and adds roughly 7,800 foods.

Both files load on first use, not at boot, and the service worker keeps them
afterwards, so search works with no connection.

## How a food gets its numbers

Filled from the cheapest source that knows the answer, and nothing you typed is
ever overwritten:

1. the fields you filled in, free and instant
2. your own library, scaled to the amount, free and instant
3. the bundled database, free and instant, works offline
4. Open Food Facts, one free network call, for packaged goods
5. the model, and only for what is still blank

Everything you log joins the library automatically, stored per unit, so the
second time you eat it the name and an amount are enough.

## Model tiers

Logging, label reading, portion changes and gap-filling use the fast model
because you are waiting on them. The coach, the assistant and recipe generation
use the deeper one. Each tier remembers separately which model was accepted.

## Building the Android package

The web version runs from GitHub Pages and shares Chrome's storage. The packaged
version has its own private storage, real background notifications, and Health
Connect access.

The APK is built in the cloud, so nothing needs installing on your machine.

1. Actions tab, **Build APK**, Run workflow, choose `remote`
2. Wait about five minutes, download the `boulder-apk` artifact
3. On the phone, allow installs from your browser, open the APK, install
4. Import a backup from the web version

`remote` points the shell at your Pages URL, so the web layer still updates by
pasting a file and the APK almost never needs rebuilding. `bundled` ships the
web files inside the APK instead: fully self-contained, but every change needs a
new build.

### Signing

Without a signing key each build gets a fresh signature, so updates need an
uninstall first, which deletes the app's data. To avoid that, run the
**Make signing key** workflow once on a PRIVATE repository, copy the two values
it prints into repository secrets as `KEYSTORE_B64` and `KEYSTORE_PASS`, then
delete the run. Later builds install over the old app.

### Health Connect

Samsung Health writes into Health Connect and Boulder reads from there. In the
app: gear, Data and setup, Health Connect, Connect. Weigh-ins only fill days you
have not recorded yourself, so nothing you typed is overwritten.

If nothing appears, open Samsung Health, Settings, Health Connect, and check it
is permitted to write the data you want.

### Backups

Storage lives inside the packaged app, so uninstalling deletes it. A dated JSON
is written to `Documents/Boulder` once a day without being asked.

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
