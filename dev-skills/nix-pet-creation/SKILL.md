---
name: nix-pet-creation
description: Create or revise an animated companion appearance for the Nix workspace app. Use for Nix pet character art, sprite atlases, animation repair, or adding a built-in appearance to the pet picker.
---

# Create a Nix pet

Work from the Nix repository root. Use the paths below relative to that root. For a profile using an existing look, use the pet settings flow and skip the art pipeline. For a new look, produce a transparent WebP atlas, its Nix JSON metadata, and a preview. Wire it into the picker when the request calls for a usable in-app appearance.

## Design the pet

1. Open a shipped atlas in `apps/web/public/pets/` and compare idle frame 0 at the compact 56 px and regular 96 px avatar sizes. Neko is a reference for expressive faces, Moth for antennae and wings, Phoenix Chick for a tall crest, and Axolotl for a wide silhouette. Read the corresponding JSON under `packages/web-pets/src/pets/`. Use the v2 layout of the WebP pets. Owl uses an older variable-height PNG layout.
2. Generate one neutral pose and check its silhouette at 56 px on light and dark backgrounds. Use a legible face, a compact body and one or two identifying features. Save this pose as the character reference. Attach it to every strip to hold the palette, markings, proportions and outline steady.
3. Generate the six-frame idle strip first. Ask for one horizontal row with clear gutters between complete poses and padding at both ends. Number the poses in playback order. Check the decoded alpha in the gutters and at the sheet edges. A PNG can contain an alpha channel and still have a visible backdrop. If the generator leaves a matte, ask for a flat saturated green background if that colour is absent from the pet, then remove it with the strip preparer below. Inspect the pilot loop at both avatar sizes.
4. Make one strip per row in the table. You can generate several strips on one sheet by asking for stacked bands with wide blank gutters and specifying the pose count and motion for each band. Use a dedicated wide strip when large silhouettes, such as mushroom caps or wings, crowd the eight-pose band. Describe which feature moves and which stay fixed. Name the same limb by side and attachment when it moves across multiple frames. Keep a steady viewpoint and a comparable resting silhouette in the first frame of every strip. Make that first pose readable on its own and appropriate for both states when they share a row. Plan the last pose to lead back into it. Inspect each strip for continuity of limbs, markings and motion. If a limb changes sides or appears twice, regenerate that strip with simpler motion and the same reference.

## Pack the atlas

Use `pet-avatar.tsx` and `neko-atlas.json` in `packages/web-pets/src/pets/` as the playback contract. Copy the JSON as a starting point and change `source` to `<slug>-atlas.webp`. Keep the 8-column, 11-row v2 grid, with 192 × 208 px cells and a 1536 × 2288 px image. The shipped presets use 180 ms per step. Rows and columns are zero-based.

| Row | Frames | Nix state and motion |
| --- | ---: | --- |
| 0 | 6 | `idle`. Neutral first frame, then a small blink or breathing loop. |
| 3 | 4 | `speaking`. Small mouth or head motion, or a greeting gesture like the shipped wave. |
| 4 | 5 | `hover`. A brief perk-up or hop. |
| 5 | 8 | `error`. A subdued droop, then settle. |
| 6 | 6 | `listening` and `awaiting-approval`. An attentive, expectant pose. |
| 7 | 6 | `working`. A repeatable activity that stays within the cell. |
| 8 | 6 | `thinking` and `success`. A focused beat followed by a soft reaction. |

Save transparent PNG strips under the first state named in each row, such as `idle.png` and `listening.png`. Keep sources and previews in `artifacts/nix-pets/<slug>/` while reviewing. Run the scripts from the repository root with `PET_SKILL_DIR` set to the directory containing this skill. To split a sheet, pass the state names in the same top-to-bottom order as the bands. Pass `--green-key` for a saturated green matte and omit it for an already transparent sheet. The [strip preparer](scripts/prepare_strips.py) also works with one band.

```sh
uv run --with pillow python -B "$PET_SKILL_DIR/scripts/prepare_strips.py" \
  artifacts/nix-pets/moth/qa/expressive-keyed.png artifacts/nix-pets/moth/sources \
  speaking hover error --green-key
```

Start the [atlas packer](scripts/pack_atlas.py) with `--pilot` to preview idle, then drop that flag to export the full atlas and metadata.

```sh
uv run --with pillow python "$PET_SKILL_DIR/scripts/pack_atlas.py" \
  octopus artifacts/nix-pets/octopus/sources artifacts/nix-pets/octopus --pilot
```

The packer finds gutters using substantially opaque pixels. Generated PNGs can contain faint alpha specks outside the art and poses can drift across nominal slots. If the packer reports the wrong count or a clipped pose, inspect the source and regenerate the affected strip with more room. The packer normalizes the opening width of each strip and fits all poses to a common size and resting baseline. This leaves room for tall antennae and preserves motion above the baseline. Compare the opening poses across rows for scale jumps. If detached parts look like extra poses or the silhouette changes substantially, place the frames into the atlas cells by hand using a common body landmark and the Neko metadata as a template.

The full export puts the sampled frames in the leftmost cells and keeps unused cells transparent. Nix never samples rows 1, 2, 9 or 10, or the extra neutral frame at row 0, column 6 in the shipped sheets. Preserve those cells when importing a compatible existing 8 × 11 atlas and verify its row meanings against the table. Keep all six idle frames. The renderer holds frame 0 for four steps before playing frames 1 through 5. Reduced motion shows frame 0 of the current state.

## Add a built-in appearance

1. Put the WebP in `apps/web/public/pets/` and its metadata in `packages/web-pets/src/pets/`. Use one stable appearance slug in the registry, catalog and validators. Neko is a historical exception with appearance ID `cat`.
2. Register the JSON in `packages/web-pets/src/pets/pet-avatar.tsx`. Add the preset to `packages/web-pets/src/pets/catalog.ts` with its display name, description and an existing personality value. The picker reads that catalog.
3. Accept the slug in `packages/api-client/src/schemas/pets.ts` and Core's `backend/src/Nix.Api/Features/Pets/PetSettingsUseCases.cs`. Keep existing appearance IDs valid for saved profiles. Add coverage to the existing schema, Core settings and picker test cases for the new slug. The atlas geometry test iterates over registered v2 pets. Follow the repository's changed-path checks and add the appearance to the Unreleased changelog.

## Verify the result

- Decode the final WebP. Check its dimensions against the JSON, make sure all nine Nix states map to valid rows, and check each sampled cell for visible art and transparent padding. Confirm that each declared frame count fits its row and that `source` matches the filename.
- Inspect the contact sheet and the loop preview for every sampled row. Judge the edges on composited light and dark backgrounds at 56 and 96 px. Look for clipping, halos, scale or baseline jumps, changing markings or anatomy, and jumps at the loop seam. Compare each row's frame 0 with the idle pose for reduced-motion playback and state transitions.
- For an integrated pet, select it in the Nix pet picker, save and reload, and verify that the appearance persists and the avatar loads. Check normal and reduced motion through the existing avatar renderer. Report which checks ran and link the atlas, metadata and preview.
