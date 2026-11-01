# Canvas and diagrams

## Canvas

A canvas is a body kind for drawing: whiteboards, sketches, flow charts and architecture diagrams. It is built on Excalidraw and synchronised live like a note, so several people can draw on the same canvas at once.

- **Item cards.** Place a Nix item on the canvas as a card that shows its properties. Open the item from the card.
- **Images.** Drop images onto the canvas. They are stored as Nix file items that the canvas owns, never as temporary links.
- **Your library.** Save a selection of shapes to your personal library and reuse it in any drawing.
- **Import.** Bring in Excalidraw scenes and PNG files with an embedded scene. If an import cannot be completed, the existing drawing is left as it was.

Because canvas is a body kind, a canvas can also have children and views, like any other item.

## Mermaid diagrams

Write a code block with the language `mermaid` in any note and Nix renders it as a diagram, keeping the source editable beside it:

```text
```mermaid
flowchart LR
  Idea --> Draft --> Review --> Published
```
```

Uploaded `.mmd` and `.mermaid` files open in the same viewer. Diagrams render with strict security settings and follow the light or dark theme. The source is what is stored; the picture is derived from it.

## Properties

- title: Canvas and diagrams

