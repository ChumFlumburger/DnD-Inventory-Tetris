# ⚔ The Vault — D&D 5e Shared Inventory

A real-time, Tetris-style D&D inventory system for you and your party.

---

## Quick Start (Local)

```bash
npm install
npm start
```

Then open `public/index.html` in your browser and set the server URL to `http://localhost:3001`.

---

## Deploying to Render (Free)

1. Push this project to a GitHub repo
2. Go to [render.com](https://render.com) and create a free account
3. Click **New → Web Service** and connect your repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Click **Deploy**
6. Once deployed, copy your Render URL (e.g. `https://the-vault-abc123.onrender.com`)

---

## Sharing with Friends

Once deployed:

1. **Host the frontend** — you can open `public/index.html` directly in a browser, or host it on [GitHub Pages](https://pages.github.com/) or [Netlify Drop](https://app.netlify.com/drop) (just drag and drop the `public/` folder).
2. **Share the server URL** — tell your friends to paste your Render URL into the "Server URL" field.
3. **Create a campaign** — the DM creates a campaign and gets a 6-character join code.
4. **Players join** — players enter the code to join the session.

---

## How it Works

| Feature | Details |
|---|---|
| Tetris grid | 10×8 grid, items take 1–3 cells wide/tall |
| Drag & drop | Drag items to rearrange in your inventory |
| Real-time sync | All changes sync instantly via WebSockets |
| DM tools | DM can view all inventories, add/give/remove items |
| Compendium | 20 pre-loaded D&D 5e items ready to add |
| Custom items | DM can create any item with name, type, rarity, size |
| Right-click | Context menu to give or remove items |
| Hover tooltips | Shows item details on hover |

---

## Tech Stack

- **Backend:** Node.js, Express, Socket.io
- **Frontend:** Vanilla HTML/CSS/JS (single file, no framework needed)
- **Hosting:** Render (backend) + any static host (frontend)

---

## Notes

- All data is in-memory — server restart clears campaigns. For persistence, a database (like SQLite or MongoDB) would need to be added.
- The frontend `index.html` can be opened locally or hosted anywhere static.
