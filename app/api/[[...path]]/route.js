import { randomUUID } from "crypto";
import { MongoClient } from "mongodb";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) throw new Error("MONGO_URL is not configured");

const client = new MongoClient(mongoUrl, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
});

const globalMongo = globalThis;
const mongoPromise = globalMongo.__teenPattiMongoPromise || client.connect();
if (process.env.NODE_ENV !== "production") globalMongo.__teenPattiMongoPromise = mongoPromise;

const json = (payload, status = 200) => NextResponse.json(payload, { status });
const fail = (message, status = 400) => json({ error: message }, status);
const nowIso = () => new Date().toISOString();
const roundMoney = (value) => Math.round(Number(value) * 100) / 100;
const toCents = (value) => Math.round(Number(value) * 100);
const normalizePath = (path) => path[0] === "games" ? path.slice(1) : path;

async function collection() {
  const connected = await mongoPromise;
  const database = process.env.DB_NAME && process.env.DB_NAME !== "your_database_name"
    ? connected.db(process.env.DB_NAME)
    : connected.db();
  const sessions = database.collection("teen_patti_sessions");
  await sessions.createIndex({ gameCode: 1 }, { unique: true });
  await sessions.createIndex({ updatedAt: -1 });
  return sessions;
}

function makeGameCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "TP-";
  for (let index = 0; index < 5; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function validatePlayers(players) {
  if (!Array.isArray(players) || players.length < 2) return "Please add at least 2 players.";
  if (players.length > 20) return "You can add up to 20 players.";
  const names = players.map((player) => cleanName(player.name));
  if (names.some((name) => !name || name.length > 40)) return "Each player needs a name up to 40 characters.";
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return "Player names must be unique in this game.";
  }
  return null;
}

function publicSession(session) {
  const { hostToken, ...safe } = session;
  return safe;
}

async function findSession(identifier) {
  const sessions = await collection();
  return sessions.findOne({ $or: [{ _id: identifier }, { gameCode: String(identifier).toUpperCase() }] });
}

async function saveSession(session) {
  const sessions = await collection();
  session.updatedAt = nowIso();
  session.revision = (session.revision || 0) + 1;
  await sessions.replaceOne({ _id: session._id }, session);
  return session;
}

function hostOnly(session, body) {
  return typeof body?.hostToken === "string" && body.hostToken === session.hostToken;
}

function getRound(session) {
  return session.rounds.find((round) => round.gameNumber === session.currentGameNumber);
}

function activePlayer(round, playerId) {
  return round?.players.find((player) => player.playerId === playerId);
}

function makeRound(session, gameNumber) {
  const players = session.players.map((player) => ({
    playerId: player.id,
    name: player.name,
    contribution: roundMoney(session.baseAmount),
    status: "playing",
  }));
  return {
    id: randomUUID(),
    gameNumber,
    baseAmount: roundMoney(session.baseAmount),
    currentAmount: roundMoney(session.baseAmount),
    status: "active",
    winnerId: null,
    players,
    actions: [{
      id: randomUUID(),
      actionType: "START",
      amount: roundMoney(session.baseAmount),
      timestamp: nowIso(),
      previousPlayers: players,
      previousCurrentAmount: roundMoney(session.baseAmount),
    }],
    startedAt: nowIso(),
    endedAt: null,
  };
}

function completedRounds(session) {
  return session.rounds.filter((round) => round.status === "complete" && round.winnerId);
}

function calculateBalances(session) {
  const centsByPlayer = new Map(session.players.map((player) => [player.id, 0]));
  completedRounds(session).forEach((round) => {
    const total = round.players.reduce((sum, player) => sum + toCents(player.contribution), 0);
    round.players.forEach((player) => {
      const current = centsByPlayer.get(player.playerId) || 0;
      centsByPlayer.set(player.playerId, current + (player.playerId === round.winnerId
        ? total - toCents(player.contribution)
        : -toCents(player.contribution)));
    });
  });
  return session.players.map((player) => ({
    playerId: player.id,
    name: player.name,
    balance: (centsByPlayer.get(player.id) || 0) / 100,
  }));
}

function calculateSettlement(session) {
  const balances = calculateBalances(session);
  const totalCents = balances.reduce((sum, player) => sum + toCents(player.balance), 0);
  const isBalanced = totalCents === 0;
  const creditors = balances.filter((player) => toCents(player.balance) > 0)
    .map((player) => ({ ...player, cents: toCents(player.balance) }));
  const debtors = balances.filter((player) => toCents(player.balance) < 0)
    .map((player) => ({ ...player, cents: Math.abs(toCents(player.balance)) }));
  const transfers = [];
  let creditorIndex = 0;
  let debtorIndex = 0;
  while (isBalanced && creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amount = Math.min(creditor.cents, debtor.cents);
    transfers.push({ from: debtor.name, to: creditor.name, amount: amount / 100 });
    creditor.cents -= amount;
    debtor.cents -= amount;
    if (creditor.cents === 0) creditorIndex += 1;
    if (debtor.cents === 0) debtorIndex += 1;
  }
  return {
    balances,
    transfers,
    totalAmount: transfers.reduce((sum, transfer) => sum + transfer.amount, 0),
    isBalanced,
    discrepancy: Math.abs(totalCents) / 100,
    gamesCompleted: completedRounds(session).length,
  };
}

function summary(session) {
  const rounds = completedRounds(session);
  const activity = session.players.map((player) => ({
    ...player,
    gamesPlayed: rounds.length,
    gamesPacked: rounds.reduce((count, round) => count + (round.players.find((entry) => entry.playerId === player.id)?.status === "packed" ? 1 : 0), 0),
  }));
  return { gamesCompleted: rounds.length, gamesRemaining: Math.max(session.totalGames - rounds.length, 0), activity, rounds };
}

async function handleGet(path) {
  path = normalizePath(path);
  if (path.length === 0) {
    const sessions = await collection();
    const rows = await sessions.find({}, { projection: { hostToken: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray();
    return json({ games: rows });
  }
  const session = await findSession(path[0]);
  if (!session) return fail("Game not found. Check the Game Code and try again.", 404);
  if (path[1] === "summary") return json({ summary: summary(session) });
  if (path[1] === "settlement") return json({ settlement: calculateSettlement(session) });
  if (path.length > 1) return fail("That game action was not found.", 404);
  return json({ game: publicSession(session) });
}

async function handlePost(path, request) {
  path = normalizePath(path);
  const body = await request.json().catch(() => ({}));
  if (path.length === 0) {
    const gameName = cleanName(body.gameName || body.name);
    const baseAmount = roundMoney(body.baseAmount);
    const totalGames = Number(body.totalGames);
    const players = Array.isArray(body.players) ? body.players.map((player) => ({ name: cleanName(player.name) })) : [];
    const playerError = validatePlayers(players);
    if (!gameName) return fail("Please enter a game name.");
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return fail("Please enter a starting amount greater than zero.");
    if (!Number.isInteger(totalGames) || totalGames < 1 || totalGames > 200) return fail("Choose between 1 and 200 games.");
    if (playerError) return fail(playerError);
    const sessions = await collection();
    let gameCode = makeGameCode();
    while (await sessions.findOne({ gameCode })) gameCode = makeGameCode();
    const createdAt = nowIso();
    const session = {
      _id: randomUUID(),
      gameCode,
      hostToken: randomUUID(),
      gameName,
      baseAmount,
      totalGames,
      currentGameNumber: 1,
      status: "setup",
      players: players.map((player) => ({ id: randomUUID(), name: player.name, createdAt })),
      rounds: [],
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    await sessions.insertOne(session);
    return json({ game: publicSession(session), hostToken: session.hostToken }, 201);
  }

  const session = await findSession(path[0]);
  if (!session) return fail("Game not found. Check the Game Code and try again.", 404);
  if (!hostOnly(session, body)) return fail("Only the host can make that change.", 403);
  const action = path[1];

  if (action === "players") {
    if (session.status !== "setup") return fail("Players can only be changed before the session starts.");
    const name = cleanName(body.name);
    if (!name) return fail("Please enter a player name.");
    if (session.players.length >= 20) return fail("You can add up to 20 players.");
    if (session.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return fail("Player names must be unique in this game.");
    session.players.push({ id: randomUUID(), name, createdAt: nowIso() });
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "start") {
    if (session.status !== "setup") return fail("This session has already started.");
    if (session.players.length < 2) return fail("Please add at least 2 players.");
    session.status = "active";
    session.currentGameNumber = 1;
    session.rounds = [makeRound(session, 1)];
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "action") {
    const round = getRound(session);
    if (!round || round.status !== "active") return fail(`Game ${session.currentGameNumber} has already finished.`);
    if (body.actionType !== "PLAY") return fail("Choose a valid player action.");
    const player = activePlayer(round, body.playerId);
    if (!player) return fail("That player is not in this game.");
    if (player.status === "packed") return fail(`${player.name} has already packed.`);
    const amount = roundMoney(body.amount ?? round.currentAmount);
    if (!Number.isFinite(amount) || amount <= 0) return fail("Amount must be greater than zero.");
    if (amount < player.contribution) return fail("A recorded amount cannot be lower than the player’s previous amount.");
    const previousPlayers = JSON.parse(JSON.stringify(round.players));
    const previousCurrentAmount = round.currentAmount;
    player.contribution = amount;
    round.actions.push({ id: randomUUID(), actionType: "PLAY", playerId: player.playerId, playerName: player.name, amount, timestamp: nowIso(), previousPlayers, previousCurrentAmount });
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "pack") {
    const round = getRound(session);
    if (!round || round.status !== "active") return fail(`Game ${session.currentGameNumber} has already finished.`);
    const player = activePlayer(round, body.playerId);
    if (!player) return fail("That player is not in this game.");
    if (player.status === "packed") return fail(`${player.name} has already packed.`);
    const previousPlayers = JSON.parse(JSON.stringify(round.players));
    player.status = "packed";
    round.actions.push({ id: randomUUID(), actionType: "PACK", playerId: player.playerId, playerName: player.name, amount: player.contribution, timestamp: nowIso(), previousPlayers, previousCurrentAmount: round.currentAmount });
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "amount") {
    const round = getRound(session);
    const amount = roundMoney(body.amount);
    if (!round || round.status !== "active") return fail(`Game ${session.currentGameNumber} has already finished.`);
    if (!Number.isFinite(amount) || amount <= 0) return fail("Amount must be greater than zero.");
    round.actions.push({ id: randomUUID(), actionType: "AMOUNT", amount, timestamp: nowIso(), previousPlayers: JSON.parse(JSON.stringify(round.players)), previousCurrentAmount: round.currentAmount });
    round.currentAmount = amount;
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "undo") {
    const round = getRound(session);
    if (!round || round.status !== "active") return fail("You can only undo an action during an active game.");
    const target = [...round.actions].reverse().find((entry) => !entry.undone && ["PLAY", "PACK", "AMOUNT"].includes(entry.actionType));
    if (!target) return fail("There is no action to undo yet.");
    round.players = target.previousPlayers;
    round.currentAmount = target.previousCurrentAmount;
    target.undone = true;
    round.actions.push({ id: randomUUID(), actionType: "UNDO", targetActionId: target.id, timestamp: nowIso(), amount: 0 });
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "finish-round") {
    const round = getRound(session);
    if (!round || round.status !== "active") return fail(`Game ${session.currentGameNumber} has already finished.`);
    const winner = activePlayer(round, body.winnerId);
    if (!winner) return fail("Please select the winner before finishing the game.");
    round.status = "complete";
    round.winnerId = winner.playerId;
    round.endedAt = nowIso();
    round.actions.push({ id: randomUUID(), actionType: "FINISH", playerId: winner.playerId, playerName: winner.name, amount: winner.contribution, timestamp: nowIso() });
    if (session.currentGameNumber === session.totalGames) session.status = "complete";
    await saveSession(session);
    return json({ game: publicSession(session), settlement: session.status === "complete" ? calculateSettlement(session) : null });
  }

  if (action === "next-round") {
    const round = getRound(session);
    if (session.status !== "active" || !round || round.status !== "complete") return fail("Finish the current game before starting the next one.");
    if (session.currentGameNumber >= session.totalGames) return fail(`Cannot start Game ${session.totalGames + 1} because the session is complete.`);
    session.currentGameNumber += 1;
    session.rounds.push(makeRound(session, session.currentGameNumber));
    await saveSession(session);
    return json({ game: publicSession(session) });
  }

  if (action === "end") {
    if (!["complete", "active"].includes(session.status)) return fail("This session is already closed.");
    session.status = "ended";
    await saveSession(session);
    return json({ game: publicSession(session), settlement: calculateSettlement(session) });
  }

  return fail("That game action was not found.", 404);
}

export async function GET(request, context) {
  try {
    const path = (await context.params)?.path || [];
    return await handleGet(path);
  } catch (error) {
    console.error("Teen Patti GET error", error);
    return fail("Unable to load the game right now. Please try again.", 500);
  }
}

export async function POST(request, context) {
  try {
    const path = (await context.params)?.path || [];
    return await handlePost(path, request);
  } catch (error) {
    console.error("Teen Patti POST error", error);
    return fail("Unable to save that change right now. Please try again.", 500);
  }
}