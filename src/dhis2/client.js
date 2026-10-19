// Minimal DHIS2 Web API client. Connection comes from the server environment:
//   DHIS2_URL       e.g. https://dhis2.example.org   (no trailing /api)
//   DHIS2_TOKEN     personal access token (preferred), or
//   DHIS2_USERNAME / DHIS2_PASSWORD
// Works with the tracker API (2.36+) and falls back to the older events API.

const TIMEOUT_MS = 45000;

class Dhis2Error extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function connection() {
  const raw = String(process.env.DHIS2_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  if (!raw) return null;
  let auth = null;
  if (process.env.DHIS2_TOKEN) auth = `ApiToken ${String(process.env.DHIS2_TOKEN).trim()}`;
  else if (process.env.DHIS2_USERNAME) {
    auth = `Basic ${Buffer.from(`${process.env.DHIS2_USERNAME}:${process.env.DHIS2_PASSWORD || ""}`).toString("base64")}`;
  }
  if (!auth) return null;
  return { baseUrl: raw, auth };
}

const isConfigured = () => !!connection();

async function request(path, { method = "GET", query, body } = {}) {
  const conn = connection();
  if (!conn) throw new Dhis2Error("DHIS2 is not configured on the server (set DHIS2_URL and DHIS2_TOKEN in .env)", 503);
  const url = new URL(`${conn.baseUrl}/api/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: conn.auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (err) {
    throw new Dhis2Error(`Cannot reach DHIS2 at ${conn.baseUrl}: ${err.cause?.code || err.message}`, 502);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. login page)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Dhis2Error("DHIS2 redirected the request (check DHIS2_URL and that the credentials are accepted)", 502);
  }
  if (!res.ok) {
    const msg = json?.message || json?.response?.description || text.slice(0, 200) || res.statusText;
    throw new Dhis2Error(`DHIS2 ${res.status}: ${msg}`, res.status, json);
  }
  if (json === null && text) throw new Dhis2Error("DHIS2 did not return JSON (check DHIS2_URL)", 502);
  return json;
}

async function systemInfo() {
  const [info, me] = await Promise.all([request("system/info"), request("me", { query: { fields: "id,username,displayName,authorities" } })]);
  return {
    version: info.version,
    revision: info.revision,
    serverDate: info.serverDate,
    systemName: info.systemName,
    user: { username: me.username, displayName: me.displayName },
  };
}

async function programs() {
  const r = await request("programs", {
    query: { fields: "id,displayName,programType,programStages[id,displayName]", paging: "false", order: "displayName:asc" },
  });
  return r.programs || [];
}

async function program(id) {
  return request(`programs/${encodeURIComponent(id)}`, {
    query: {
      fields:
        "id,displayName,programType," +
        "programStages[id,displayName,programStageDataElements[dataElement[id,displayName,code,valueType]]]," +
        "organisationUnits[id,displayName,code,path,level,parent[displayName]]",
    },
  });
}

async function aggregateDataElements(q) {
  const filters = ["domainType:eq:AGGREGATE"];
  if (q) filters.push(`identifiable:token:${q}`);
  const r = await request("dataElements", {
    query: {
      filter: filters,
      fields: "id,displayName,code,valueType,dataSetElements[dataSet[id,displayName,periodType]]",
      pageSize: 50,
      order: "displayName:asc",
    },
  });
  return r.dataElements || [];
}

// Events of a program (and stage) updated after a timestamp, page by page.
// Returns normalised { event, orgUnit, occurredAt, updatedAt, status, deleted, dataValues }.
// Timestamps go to DHIS2 as its own wall clock (no zone), see sync.js.
const wall = (d) => (!d ? undefined : typeof d === "string" ? d : d.toISOString().replace(/Z$/, ""));

async function eventsPage({ programId, programStageId, updatedAfter, orgUnit, page, pageSize = 500 }) {
  const norm = (e) => ({
    event: e.event,
    orgUnit: e.orgUnit,
    occurredAt: e.occurredAt || e.eventDate || null,
    updatedAt: e.updatedAt || e.lastUpdated || null,
    status: e.status,
    deleted: !!e.deleted,
    dataValues: e.dataValues || [],
  });
  try {
    const r = await request("tracker/events", {
      query: {
        program: programId,
        programStage: programStageId,
        updatedAfter: wall(updatedAfter),
        orgUnit,
        ouMode: orgUnit ? "DESCENDANTS" : "ACCESSIBLE",
        includeDeleted: "true",
        fields: "event,orgUnit,occurredAt,updatedAt,status,deleted,dataValues[dataElement,value]",
        order: "updatedAt:asc",
        page,
        pageSize,
      },
    });
    const list = r.instances || r.events || [];
    return { events: list.map(norm), more: list.length >= pageSize };
  } catch (err) {
    if (err.status !== 404) throw err;
    // Older DHIS2 (before the tracker API)
    const r = await request("events", {
      query: {
        program: programId,
        programStage: programStageId,
        lastUpdatedStartDate: wall(updatedAfter),
        orgUnit,
        ouMode: orgUnit ? "DESCENDANTS" : "ACCESSIBLE",
        includeDeleted: "true",
        fields: "event,orgUnit,eventDate,lastUpdated,status,deleted,dataValues[dataElement,value]",
        order: "lastUpdated:asc",
        page,
        pageSize,
        totalPages: "false",
      },
    });
    const list = r.events || [];
    return { events: list.map(norm), more: list.length >= pageSize };
  }
}

// DHIS2 answers 409 when some values are refused, with the import summary
// (counts and conflicts) in the body: return it rather than throw.
async function postDataValues(dataValues) {
  try {
    return await request("dataValueSets", { method: "POST", query: { importStrategy: "CREATE_AND_UPDATE" }, body: { dataValues } });
  } catch (err) {
    if (err instanceof Dhis2Error && err.status === 409 && err.body && (err.body.response || err.body.importCount)) return err.body;
    throw err;
  }
}

module.exports = { Dhis2Error, isConfigured, connection, request, systemInfo, programs, program, aggregateDataElements, eventsPage, postDataValues };
