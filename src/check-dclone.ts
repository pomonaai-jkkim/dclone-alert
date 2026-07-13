import { promises as fs } from "node:fs";
import path from "node:path";

type Region = "us" | "eu" | "asia";
type DCloneStateNumber = 0 | 1 | 2 | 3 | 4 | 5;

type D2tzDCloneState = {
  region: Region | string;
  state: DCloneStateNumber | number;
  displayState?: number;
};

type D2tzErrorResponse = {
  status?: unknown;
  error?: unknown;
  message?: unknown;
  statusCode?: unknown;
};

type StoredState = Partial<Record<Region, number>>;

type CheckResult = {
  checked: number;
  notified: Array<{ region: Region; state: number }>;
  storage: "redis" | "local-file";
};

const D2TZ_DC_URL = "https://api.d2tz.info/public/dc?region=all";
const REDIS_STATE_KEY = "dclone:last-notified";
const WATCHED_REGIONS: Region[] = ["us", "eu", "asia"];
const LOCAL_STATE_FILE = path.join(process.cwd(), ".dclone-state.json");

function isD2tzErrorResponse(value: unknown): value is D2tzErrorResponse {
  return typeof value === "object" && value !== null && ("error" in value || "message" in value || "status" in value || "statusCode" in value);
}

function isValidDCloneState(value: unknown): value is D2tzDCloneState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Partial<D2tzDCloneState>;
  return (
    typeof item.region === "string" &&
    typeof item.state === "number" &&
    (item.displayState === undefined || typeof item.displayState === "number")
  );
}

function isWatchedRegion(region: string): region is Region {
  return WATCHED_REGIONS.includes(region as Region);
}

function shouldNotify(item: D2tzDCloneState): item is D2tzDCloneState & { region: Region } {
  return (
    isWatchedRegion(item.region) &&
    item.state >= 3
  );
}

function selectLastStateByRegion(states: D2tzDCloneState[]): Partial<Record<Region, D2tzDCloneState & { region: Region }>> {
  const lastStateByRegion: Partial<Record<Region, D2tzDCloneState & { region: Region }>> = {};

  for (const state of states) {
    if (isWatchedRegion(state.region)) {
      lastStateByRegion[state.region] = { ...state, region: state.region };
    }
  }

  return lastStateByRegion;
}

async function fetchDCloneStates(): Promise<D2tzDCloneState[]> {
  const token = process.env.D2TZ_API_TOKEN;
  if (!token) {
    throw new Error("D2TZ_API_TOKEN is not configured.");
  }

  const response = await fetch(D2TZ_DC_URL, {
    method: "GET",
    headers: {
      Authorization: token,
      Accept: "application/json"
    }
  });

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(`d2tz API failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (isD2tzErrorResponse(payload) && !Array.isArray(payload)) {
    throw new Error(`d2tz API returned an error object: ${JSON.stringify(payload)}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`d2tz API returned an unexpected payload: ${JSON.stringify(payload)}`);
  }

  const validStates = payload.filter(isValidDCloneState);
  if (validStates.length !== payload.length) {
    throw new Error("d2tz API returned one or more invalid Diablo Clone state objects.");
  }

  return validStates;
}

async function loadStateFromRedis(): Promise<StoredState | undefined> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return undefined;
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(REDIS_STATE_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = (await response.json()) as { result?: string | null };

  if (!response.ok) {
    throw new Error(`Upstash GET failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload.result ? (JSON.parse(payload.result) as StoredState) : {};
}

async function saveStateToRedis(state: StoredState): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return false;
  }

  const response = await fetch(`${url}/set/${encodeURIComponent(REDIS_STATE_KEY)}/${encodeURIComponent(JSON.stringify(state))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(`Upstash SET failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return true;
}

async function loadStateFromFile(): Promise<StoredState> {
  try {
    return JSON.parse(await fs.readFile(LOCAL_STATE_FILE, "utf8")) as StoredState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function saveStateToFile(state: StoredState): Promise<void> {
  await fs.writeFile(LOCAL_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function loadLastNotifiedState(): Promise<{ state: StoredState; usingRedis: boolean }> {
  const redisState = await loadStateFromRedis();
  if (redisState) {
    return { state: redisState, usingRedis: true };
  }

  console.warn("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is missing. Falling back to local file storage.");
  return { state: await loadStateFromFile(), usingRedis: false };
}

async function saveLastNotifiedState(state: StoredState, usingRedis: boolean): Promise<void> {
  if (usingRedis) {
    await saveStateToRedis(state);
    return;
  }

  await saveStateToFile(state);
}

async function sendDiscordNotification(item: D2tzDCloneState & { region: Region }): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is not configured.");
  }

  const displayState = item.displayState ?? item.state + 1;
  const content = [
    `🚨 우버디아 ${item.region.toUpperCase()}서버에서 ${displayState}단계! 🚨`,
    `Log: ${item.region.toUpperCase()} Non-Ladder RotW Softcore State ${displayState}/6`
  ].join("\n");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`Discord webhook failed for ${item.region} state ${item.state}: HTTP ${response.status} ${body}`);
    throw new Error(`Discord webhook failed with HTTP ${response.status}.`);
  }
}

export async function runDCloneCheck(): Promise<CheckResult> {
  const [states, stored] = await Promise.all([fetchDCloneStates(), loadLastNotifiedState()]);
  const lastNotified = { ...stored.state };
  const lastStateByRegion = selectLastStateByRegion(states);
  const selectedStates = WATCHED_REGIONS.flatMap((region) => {
    const state = lastStateByRegion[region];
    return state ? [state] : [];
  });
  const notifications: Array<{ region: Region; state: number }> = [];

  console.log(
    "DClone selected states:",
    selectedStates.map((state) => ({
      region: state.region,
      state: state.state,
      displayState: state.displayState ?? state.state + 1
    }))
  );

  for (const region of WATCHED_REGIONS) {
    const current = lastStateByRegion[region];

    if (!current || current.state < 3) {
      delete lastNotified[region];
      continue;
    }

    if (shouldNotify(current) && lastNotified[region] !== current.state) {
      await sendDiscordNotification(current);
      lastNotified[region] = current.state;
      notifications.push({ region, state: current.state });
    }
  }

  await saveLastNotifiedState(lastNotified, stored.usingRedis);

  return {
    checked: selectedStates.length,
    notified: notifications,
    storage: stored.usingRedis ? "redis" : "local-file"
  };
}

try {
  const result = await runDCloneCheck();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error.";
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}
