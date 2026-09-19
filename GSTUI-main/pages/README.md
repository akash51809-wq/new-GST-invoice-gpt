# GSTUI Modular Page Architecture

The repository now has a page-module structure so future page-specific work can be isolated.

## Structure

- `dashboard/` — Dashboard HTML/CSS/JS
- `upload/` — Upload Invoice HTML/CSS/JS
- `report/` — shared Report CSS/JS plus three report sub-pages
  - `pending-invoice.*`
  - `upload-invoice.*`
  - `ai-report.*`
- `parties/` — Party List HTML/CSS/JS
- `settings/` — Settings HTML/CSS/JS
- `module-loader.js` — common module registration/mount helper

## Important

The existing `index.html`, `style.css`, and `app.js` remain the active production shell while the module migration is staged. This prevents a large one-shot rewrite from changing the current UI/design unexpectedly.

When a page is migrated into the shell, its page-specific markup goes into that page's `.html`, visual rules into `.css`, and behavior into `.js`. Common sidebar, topbar, dock, theme and navigation remain shared.
