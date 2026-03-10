const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// In-memory state
const campaigns = {}; // { campaignId: { dm, players, items, grid } }

function createCampaign(dmName) {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  campaigns[id] = {
    id,
    dm: dmName,
    players: {},
    log: []
  };
  return campaigns[id];
}

function addLog(campaign, message) {
  const entry = { message, time: new Date().toLocaleTimeString() };
  campaign.log.unshift(entry);
  if (campaign.log.length > 50) campaign.log.pop();
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create a new campaign
  socket.on('create_campaign', ({ dmName }, cb) => {
    const campaign = createCampaign(dmName);
    const player = {
      id: socket.id,
      name: dmName,
      isDM: true,
      gridCols: DEFAULT_COLS,
      gridRows: DEFAULT_ROWS,
      grid: createEmptyGrid(DEFAULT_COLS, DEFAULT_ROWS),
      items: []
    };
    campaign.players[socket.id] = player;
    socket.join(campaign.id);
    socket.campaignId = campaign.id;
    socket.playerId = socket.id;
    addLog(campaign, `${dmName} created campaign`);
    cb({ success: true, campaign: sanitize(campaign), you: player });
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Join existing campaign
  socket.on('join_campaign', ({ code, playerName }, cb) => {
    const campaign = campaigns[code.toUpperCase()];
    if (!campaign) return cb({ success: false, error: 'Campaign not found' });

    const player = {
      id: socket.id,
      name: playerName,
      isDM: false,
      gridCols: DEFAULT_COLS,
      gridRows: DEFAULT_ROWS,
      grid: createEmptyGrid(DEFAULT_COLS, DEFAULT_ROWS),
      items: []
    };
    campaign.players[socket.id] = player;
    socket.join(campaign.id);
    socket.campaignId = campaign.id;
    socket.playerId = socket.id;
    addLog(campaign, `${playerName} joined the campaign`);
    cb({ success: true, campaign: sanitize(campaign), you: player });
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Place item on grid
  socket.on('place_item', ({ targetPlayerId, item, x, y }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player) return;

    const target = campaign.players[targetPlayerId];
    if (!target) return;

    // Only DM can place on others
    if (targetPlayerId !== socket.playerId && !player.isDM) return;

    // Check grid bounds and collisions
    if (!canPlace(target.grid, item, x, y, target.gridCols, target.gridRows)) {
      socket.emit('error', { message: 'Cannot place item there' });
      return;
    }

    // Remove from source if moving
    if (item.ownerId && item.sourceX !== undefined) {
      clearItem(target.grid, item, item.sourceX, item.sourceY);
      target.items = target.items.filter(i => i.id !== item.id);
    }

    // Place item
    const placed = { ...item, x, y, ownerId: targetPlayerId, id: item.id || uuidv4() };
    placeOnGrid(target.grid, placed, x, y);
    target.items.push(placed);

    addLog(campaign, `${player.name} gave ${item.name} to ${target.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Move item within own inventory
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

    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Remove item
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
    addLog(campaign, `${player.name} removed ${item.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Add item to player (DM action)
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

    addLog(campaign, `DM gave ${item.name} to ${target.name}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Promote player to DM (only existing DMs can do this)
  socket.on('promote_to_dm', ({ targetPlayerId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    target.isDM = true;
    addLog(campaign, `${player.name} promoted ${target.name} to Dungeon Master`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Demote DM to player (only existing DMs can do this, cannot demote self if last DM)
  socket.on('demote_from_dm', ({ targetPlayerId }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;
    const dmCount = Object.values(campaign.players).filter(p => p.isDM).length;
    if (dmCount <= 1) {
      socket.emit('error', { message: 'Cannot demote the last Dungeon Master' });
      return;
    }
    target.isDM = false;
    addLog(campaign, `${player.name} demoted ${target.name} to player`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  // Resize a player's grid (DM only)
  socket.on('resize_grid', ({ targetPlayerId, cols, rows }) => {
    const campaign = campaigns[socket.campaignId];
    if (!campaign) return;
    const player = campaign.players[socket.playerId];
    if (!player || !player.isDM) return;
    const target = campaign.players[targetPlayerId];
    if (!target) return;

    const newCols = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
    const newRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));

    // Check no items would be cut off by shrinking
    for (const item of target.items) {
      if (item.x + (item.w || 1) > newCols || item.y + (item.h || 1) > newRows) {
        socket.emit('error', { message: `Cannot shrink — ${target.name} has items in that space` });
        return;
      }
    }

    // Rebuild grid at new size, re-stamp all items
    const newGrid = createEmptyGrid(newCols, newRows);
    for (const item of target.items) placeOnGrid(newGrid, item, item.x, item.y);

    target.gridCols = newCols;
    target.gridRows = newRows;
    target.grid = newGrid;

    addLog(campaign, `Jarl resized ${target.name}'s inventory to ${newCols}×${newRows}`);
    io.to(campaign.id).emit('campaign_update', sanitize(campaign));
  });

  socket.on('disconnect', () => {
    const campaign = campaigns[socket.campaignId];
    if (campaign && campaign.players[socket.id]) {
      const name = campaign.players[socket.id].name;
      delete campaign.players[socket.id];
      addLog(campaign, `${name} disconnected`);
      io.to(socket.campaignId).emit('campaign_update', sanitize(campaign));
    }
  });
});

// Grid helpers — dimensions are now per-player
const DEFAULT_COLS = 10;
const DEFAULT_ROWS = 8;
const MIN_COLS = 4;  const MAX_COLS = 20;
const MIN_ROWS = 4;  const MAX_ROWS = 16;

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

function sanitize(campaign) {
  return {
    id: campaign.id,
    dm: campaign.dm,
    log: campaign.log,
    players: Object.values(campaign.players).map(p => ({
      id: p.id, name: p.name, isDM: p.isDM, items: p.items, grid: p.grid,
      gridCols: p.gridCols, gridRows: p.gridRows
    }))
  };
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`REInventory server running on port ${PORT}`));
