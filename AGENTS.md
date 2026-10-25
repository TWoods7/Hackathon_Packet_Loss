# Notes for coding agents

Read `README.md` for setup, commands, and project layout. These are the rules that are easy to break.

## Customer data: public vs. private copy

Everything in `public/` is downloadable from the running app, so it holds only what the browser needs.

- `public/data/customers.json`: `{ "fields": ["lng", "lat"], "rows": [...] }`, rounded to 4 decimals. The map uses only these two fields plus the row position. Written by `npm run data:grid`; don't edit it by hand.
- `data/extracted/customers.json`: the full file (premise, transformer, circuitId, location, lifeSupport, ...). Ignored by Git. Every script in `scripts/dataBuildScripts/` reads this one.

Before a privacy change, `public/data/customers.json` was the full file. If a data script fails because `data/extracted/customers.json` is missing, or because a field like `premise` is missing, restore the full file from history and rerun:

```sh
mkdir -p data/extracted
git show a3a4575:public/data/customers.json > data/extracted/customers.json
```

Do not:
- copy the full file back into `public/data/`, or point a data script at `public/data/customers.json`;
- add premise, transformer, circuit, street, or life-support fields to anything under `public/`;
- add device coordinates back to `grid.json` (`devices` is `type`, `circuit`, `customers` only): `customerChains[i][0]` is the customer's transformer, and many transformers serve one home, so their coordinates would reveal exact home locations;
- show circuit IDs or other internal fields in the map UI or in assistant tool results (`src/assistantTools.js`).

## Row alignment

`grid.customerChains[i]` belongs to row `i` of `customers.json`. `npm run data:grid` writes both public files from the same full file, so commit `public/data/customers.json` and `public/data/grid.json` together.

## Restoration numbers

All repair-time and outage-length formulas live in `src/restorationModel.js`. Change them there, not in callers.
