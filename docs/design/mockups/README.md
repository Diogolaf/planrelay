# Dashboard mockups

These are the approved mockups of the dashboard (spec §13). They use the made-up "recipes-app" project, and `[NAME]` stands for the tool's name.

| File | View |
|---|---|
| `overview.html` | Overview, the home page (layout A) |
| `board.html` | Board tab, the Jira-style kanban (layout B) |
| `task.html` | Task view |

## What they are for

They are the visual reference for plan 2: layout, colors, type sizes, spacing and copy.

They are not served by the dashboard and are not part of the package. They load Google Fonts only for viewing. The product itself bundles its fonts and makes no network requests.

## How to read them

Each file was made in a design canvas. The markup uses inline styles and `{{…}}` bindings, and the data those bindings show sits in the `text/x-dc` script at the bottom of the file. Read the two together. The files do not render on their own.
