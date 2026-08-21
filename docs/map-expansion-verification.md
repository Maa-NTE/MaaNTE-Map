# Map Expansion Verification

This record covers the `13-bigworldmap-1` expansion and the local-only
`13-bigworldmap-2` comparison export.

## Baseline and modified inputs

Baseline SHA-256 (captured before editing):

```text
src/data/map-data.json                       7218CEE87DB7F368EAE9A22E3DA058B625DD39A62D88BBE862A90FD6FEC45DB1
src/data/navi-coordinate-calibration.json    604B396106A83E4B5B1E08EED461ADA4ED00E2771AC6B294870246FE7C5395E0
```

Modified SHA-256:

```text
src/data/map-data.json                       695ED3D3380313C59E6153DEB2C40C8097FB3BDCCFDF456FE52B9E59318B992C
src/data/navi-coordinate-calibration.json    F31430A663BF44CF82F8A63D11A5F5032022081A4E7C45781023347500ADCF44
```

The calibration map values changed by `(233, 1738)` Locator pixels while the
source size changed from `11264` to `13056`. The tile extent comparison first
finds the old map at `(+512, +3584)` full-resolution pixels, but image
registration finds an additional residual of approximately `(-46, -107)`
pixels inside that tile placement. The effective content offset is therefore
approximately `(466, 3477)` full-resolution pixels, or `(233, 1738)` Locator
pixels. Existing game-coordinate points remain unchanged.

## Image comparison

Command:

```powershell
python scripts/analyze-map-expansion.py C:/Tools/Output/Exports/HT/Content/UI/UI/minimap/13-bigworldmap-1 --old-tiles public/tiles/0
```

Result: `51x51` tiles (`26112x26112` pixels), best tile overlap
`new_x-old_x=+1`, `new_y-old_y=+7`, MSE `0.00109825`. Pixel-level feature
registration on the unchanged city region reports a translation of about
`(-46, -107)` pixels after that tile offset, yielding the effective offset
`(466, 3477)` reported above.

Therefore the old `44x44` map is retained at new tile `(1, 7)`: left `1`, top
`7`, right `6`, bottom `0` tiles are new.

The `13-bigworldmap-2` result is a `25x25` (`12800x12800`) lower-resolution
comparison image at `output/map_bigworld_13-2.png`; it is not tracked.

## MapSource artifact

MapSource `main` commit: `63e4ce729b1da83ac77f44f0b747953c3907542b`

The checkout has `origin=https://github.com/Maa-NTE/MapSource.git`; this clean
root commit is pushed to `main` and contains only the compressed tile pyramid
and README. No Git LFS configuration or source image is present.

```text
z=-6  1 tile
z=-5  4 tiles
z=-4 16 tiles
z=-3 49 tiles
z=-2 169 tiles
z=-1 676 tiles
z=0  2601 tiles (51x51)
```

The source/composite PNGs remain local and are not tracked. The application
repository contains no new map binaries; production uses the MapSource raw URL
from `src/data/map-data.json`.

## Verification commands

```text
npm run build                         exit 0
npm run qa:location-bundle            exit 0
npm run qa:static-location-bundle     exit 0
npm run qa                            exit 0
npm run check:encoding                exit 0
git diff --check                      exit 0
```

## Rollback

For the application repository, restore only the files listed in the patch:

```powershell
git restore -- src/data/map-data.json src/data/navi-coordinate-calibration.json src/data/locations.js src/App.vue src/composables/useMapApp.js scripts/qa-map.mjs README.md docs/websocket-api.md .gitignore
Remove-Item scripts/analyze-map-expansion.py,scripts/generate-map-source-tiles.py -Force
```

For the separate MapSource checkout, rollback to an empty repository history
only if the remote branch has been replaced deliberately:

```powershell
git -C ..\MapSource switch --orphan empty
git -C ..\MapSource rm -r --cached .
git -C ..\MapSource commit --allow-empty -m "Empty MapSource rollback"
```
