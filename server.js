const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── DATABASE SETUP ───────────────────────────────────────
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'the-north.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    dm TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS player_saves (
    campaign_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    is_dm INTEGER DEFAULT 0,
    grid_cols INTEGER DEFAULT 10,
    grid_rows INTEGER DEFAULT 8,
    items TEXT DEFAULT '[]',
    PRIMARY KEY (campaign_id, player_name)
  );

  CREATE TABLE IF NOT EXISTS ground_saves (
    campaign_id TEXT PRIMARY KEY,
    items TEXT DEFAULT '[]'
  );
`);

function dbSavePlayer(campaignId, player) {
  db.prepare(`
    INSERT INTO player_saves (campaign_id, player_name, is_dm, grid_cols, grid_rows, items)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, player_name) DO UPDATE SET
      is_dm = excluded.is_dm,
      grid_cols = excluded.grid_cols,
      grid_rows = excluded.grid_rows,
      items = excluded.items
  `).run(
    campaignId,
    player.name,
    player.isDM ? 1 : 0,
    player.gridCols,
    player.gridRows,
    JSON.stringify(player.items)
  );
}

function dbLoadPlayer(campaignId, playerName) {
  return db.prepare(
    'SELECT * FROM player_saves WHERE campaign_id = ? AND player_name = ?'
  ).get(campaignId, playerName);
}

function dbSaveGround(campaignId, items) {
  db.prepare(`
    INSERT INTO ground_saves (campaign_id, items) VALUES (?, ?)
    ON CONFLICT(campaign_id) DO UPDATE SET items = excluded.items
  `).run(campaignId, JSON.stringify(items));
}

function dbLoadGround(campaignId) {
  const row = db.prepare('SELECT items FROM ground_saves WHERE campaign_id = ?').get(campaignId);
  return row ? JSON.parse(row.items) : [];
}

function dbSaveCampaign(id, dmName) {
  db.prepare('INSERT OR IGNORE INTO campaigns (id, dm) VALUES (?, ?)').run(id, dmName);
}

function dbCampaignExists(id) {
  return !!db.prepare('SELECT id FROM campaigns WHERE id = ?').get(id);
}

// ─── IN-MEMORY STATE ──────────────────────────────────────
const campaigns = {};

function createCampaign(dmName) {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  campaigns[id] = { id, dm: dmName, players: {}, ground: [], log: [] };
  dbSaveCampaign(id, dmName);
  return campaigns[id];
}

function restoreOrGetCampaign(code) {
  if (campaigns[code]) return campaigns[code];
  if (!dbCampaignExists(code)) return null;
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(code);
  campaigns[code] = { id: code, dm: row.dm, players: {}, ground: dbLoadGround(code), log: [] };
  return campaigns[code];
}

function addLog(campaign, message) {
  const entry = { message, time: new Date().toLocaleTimeString() };
  campaign.log.unshift(entry);
  if (campaign.log.length > 50) campaign.log.pop();
}

// ─── SOCKET EVENTS ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create_campaign', ({ dmName, code }, cb) => {
    // Sanitise the code — letters and numbers only, max 12 chars
    const id = code
      ? code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
      : Math.random().toString(36).substring(2, 8).toUpperCase();

    if (!id) return cb({ success: false, error: 'Invalid campaign code' });

    // If campaign already exists, just rejoin it as DM
    let campaign = restoreOrGetCampaign(id);
    if (!campaign) {
      campaigns[id] = { id, dm: dmName, players: {}, ground: [], log: [] };
      dbSaveCampaign(id, dmName);
      campaign = campaigns[id];
    }

    // Remove any existing socket entry for this name (reconnect)
    const existing = Object.values(campaign.players).find(
      p => p.name.toLowerCase() === dmName.toLowerCase()
    );
    if (existing) delete campaign.players[existing.id];

    const saved = dbLoadPlayer(campaign.id, dmName);
    const cols  = saved ? saved.grid_cols : DEFAULT_COLS;
    const rows  = saved ? saved.grid_rows : DEFAULT_ROWS;
    const items = saved ? JSON.parse(saved.items) : [];

    const player = buildPlayer(socket.id, dmName, true, cols, rows, items);
    campaign.players[socket.id] = player;
    socket.join(campaign.id);
    socket.campaignId = campaign.id;
    socket.playerId = socket.id;
    socket.playerName = dmName;

    dbSavePlayer(campaign.id, player);
    addLog(campaign, `${dmName} ${saved ? 'returned as Jarl' : 'raised the warband'}`);
    cb({ success: true, campaign: sanitize(campaign), you: sanitizePlayer(player) });
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('join_campaign', ({ code, playerName }, cb) => {
    const campaign = restoreOrGetCampaign(code.toUpperCase());
    if (!campaign) return cb({ success: false, error: 'Campaign not found' });

    // Handle reconnect — remove old socket entry for this name
    const existing = Object.values(campaign.players).find(
      p => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (existing) delete campaign.players[existing.id];

    const saved = dbLoadPlayer(campaign.id, playerName);
    const cols  = saved ? saved.grid_cols : DEFAULT_COLS;
    const rows  = saved ? saved.grid_rows : DEFAULT_ROWS;
    const items = saved ? JSON.parse(saved.items) : [];
    const isDM  = saved ? !!saved.is_dm : false;

    const player = buildPlayer(socket.id, playerName, isDM, cols, rows, items);
    campaign.players[socket.id] = player;
    socket.join(campaign.id);
    socket.campaignId = campaign.id;
    socket.playerId = socket.id;
    socket.playerName = playerName;

    dbSavePlayer(campaign.id, player);

    const isReturning = !!saved && items.length > 0;
    addLog(campaign, isReturning
      ? `${playerName} returned to the warband`
      : `${playerName} joined the warband`
    );
    cb({ success: true, campaign: sanitize(campaign), you: sanitizePlayer(player), isReturning });
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('place_item', ({ targetPlayerId, item, x, y }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    if (targetPlayerId !== socket.playerId && !player.isDM) return;

    if (!canPlace(target.grid, item, x, y, target.gridCols, target.gridRows)) {
      socket.emit('error', { message: 'Cannot place item there' });
      return;
    }
    if (item.ownerId && item.sourceX !== undefined) {
      clearItem(target.grid, item, item.sourceX, item.sourceY);
      target.items = target.items.filter(i => i.id !== item.id);
    }
    const placed = { ...item, x, y, ownerId: targetPlayerId, id: item.id || uuidv4() };
    placeOnGrid(target.grid, placed, x, y);
    target.items.push(placed);
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `${player.name} gave ${item.name} to ${target.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('move_item', ({ itemId, fromX, fromY, toX, toY }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player) return;
    const item = player.items.find(i => i.id === itemId);
    if (!item) return;

    clearItem(player.grid, item, fromX, fromY);
    if (!canPlace(player.grid, item, toX, toY, player.gridCols, player.gridRows)) {
      placeOnGrid(player.grid, item, fromX, fromY);
      socket.emit('error', { message: 'Cannot move item there' });
      return;
    }
    placeOnGrid(player.grid, item, toX, toY);
    item.x = toX;
    item.y = toY;
    dbSavePlayer(campaign.id, player);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('remove_item', ({ targetPlayerId, itemId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    const target = campaign.players[targetPlayerId];
    if (!player || !target) return;
    if (targetPlayerId !== socket.playerId && !player.isDM) return;
    const item = target.items.find(i => i.id === itemId);
    if (!item) return;
    clearItem(target.grid, item, item.x, item.y);
    target.items = target.items.filter(i => i.id !== itemId);
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `${player.name} removed ${item.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('add_item', ({ targetPlayerId, item }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    const slot = findFreeSlot(target.grid, item, target.gridCols, target.gridRows);
    if (!slot) {
      socket.emit('error', { message: 'No space in inventory' });
      return;
    }
    const placed = { ...item, id: uuidv4(), x: slot.x, y: slot.y, ownerId: targetPlayerId };
    placeOnGrid(target.grid, placed, slot.x, slot.y);
    target.items.push(placed);
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `Jarl gave ${item.name} to ${target.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('add_item_at', ({ targetPlayerId, item, x, y }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;

    if (!canPlace(target.grid, item, x, y, target.gridCols, target.gridRows)) {
      socket.emit('error', { message: 'Cannot place item there' });
      return;
    }
    const placed = { ...item, id: uuidv4(), x, y, ownerId: targetPlayerId };
    placeOnGrid(target.grid, placed, x, y);
    target.items.push(placed);
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `Jarl placed ${item.name} in ${target.name}'s inventory`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('promote_to_dm', ({ targetPlayerId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    target.isDM = true;
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `${player.name} promoted ${target.name} to Jarl`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('demote_from_dm', ({ targetPlayerId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    const dmCount = Object.values(campaign.players).filter(p => p.isDM).length;
    if (dmCount <= 1) {
      socket.emit('error', { message: 'Cannot demote the last Jarl' });
      return;
    }
    target.isDM = false;
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `${player.name} demoted ${target.name} to warrior`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('resize_grid', ({ targetPlayerId, cols, rows }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;

    const newCols = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
    const newRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));

    for (const item of target.items) {
      if (item.x + (item.w || 1) > newCols || item.y + (item.h || 1) > newRows) {
        socket.emit('error', { message: `Cannot shrink — ${target.name} has items in that space` });
        return;
      }
    }
    const newGrid = createEmptyGrid(newCols, newRows);
    for (const item of target.items) placeOnGrid(newGrid, item, item.x, item.y);
    target.gridCols = newCols;
    target.gridRows = newRows;
    target.grid = newGrid;
    dbSavePlayer(campaign.id, target);
    addLog(campaign, `Jarl resized ${target.name}'s inventory to ${newCols}×${newRows}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Add item to ground (DM only)
  socket.on('add_to_ground', ({ item }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const placed = { ...item, id: uuidv4(), groundId: uuidv4() };
    campaign.ground.push(placed);
    dbSaveGround(campaign.id, campaign.ground);
    addLog(campaign, `Jarl placed ${item.name} on the ground`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Remove item from ground and put in player inventory
  socket.on('take_from_ground', ({ groundItemId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player) return;

    const gIdx = campaign.ground.findIndex(i => i.id === groundItemId);
    if (gIdx === -1) return;
    const item = campaign.ground[gIdx];

    const slot = findFreeSlot(player.grid, item, player.gridCols, player.gridRows);
    if (!slot) {
      socket.emit('error', { message: 'No space in your inventory' });
      return;
    }

    campaign.ground.splice(gIdx, 1);
    const placed = { ...item, id: uuidv4(), x: slot.x, y: slot.y, ownerId: player.id };
    placeOnGrid(player.grid, placed, slot.x, slot.y);
    player.items.push(placed);

    dbSaveGround(campaign.id, campaign.ground);
    dbSavePlayer(campaign.id, player);
    addLog(campaign, `${player.name} picked up ${item.name} from the ground`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Remove item from ground (DM only)
  socket.on('remove_from_ground', ({ groundItemId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const item = campaign.ground.find(i => i.id === groundItemId);
    if (!item) return;
    campaign.ground = campaign.ground.filter(i => i.id !== groundItemId);
    dbSaveGround(campaign.id, campaign.ground);
    addLog(campaign, `Jarl removed ${item.name} from the ground`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('disconnect', () => {
    const campaign = campaigns[socket.campaignId];
    if (campaign && campaign.players[socket.id]) {
      const p = campaign.players[socket.id];
      dbSavePlayer(campaign.id, p);
      delete campaign.players[socket.id];
      addLog(campaign, `${p.name} left the warband`);
      io.to(socket.campaignId).emit('campaign_update', sanitize(campaign));
    }
  });
});

// ─── GRID HELPERS ─────────────────────────────────────────
const DEFAULT_COLS = 10;
const DEFAULT_ROWS = 8;
const MIN_COLS = 4;  const MAX_COLS = 20;
const MIN_ROWS = 4;  const MAX_ROWS = 16;

function buildPlayer(socketId, name, isDM, cols, rows, items) {
  const grid = createEmptyGrid(cols, rows);
  for (const item of items) placeOnGrid(grid, item, item.x, item.y);
  return { id: socketId, name, isDM, gridCols: cols, gridRows: rows, grid, items };
}

function createEmptyGrid(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  return Array(rows).fill(null).map(() => Array(cols).fill(null));
}

function canPlace(grid, item, x, y, cols, rows) {
  const w = item.w || 1, h = item.h || 1;
  if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      if (grid[y + dy][x + dx] !== null) return false;
  return true;
}

function placeOnGrid(grid, item, x, y) {
  const w = item.w || 1, h = item.h || 1;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      grid[y + dy][x + dx] = item.id;
}

function clearItem(grid, item, x, y) {
  const w = item.w || 1, h = item.h || 1;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      if (grid[y + dy] && grid[y + dy][x + dx] === item.id)
        grid[y + dy][x + dx] = null;
}

function findFreeSlot(grid, item, cols, rows) {
  for (let y = 0; y <= rows - (item.h || 1); y++)
    for (let x = 0; x <= cols - (item.w || 1); x++)
      if (canPlace(grid, item, x, y, cols, rows)) return { x, y };
  return null;
}

function sanitizePlayer(p) {
  return { id: p.id, name: p.name, isDM: p.isDM, items: p.items, grid: p.grid, gridCols: p.gridCols, gridRows: p.gridRows };
}

function sanitize(campaign) {
  return {
    id: campaign.id,
    dm: campaign.dm,
    log: campaign.log,
    ground: campaign.ground || [],
    players: Object.values(campaign.players).map(sanitizePlayer)
  };
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`The North server running on port ${PORT}`));
