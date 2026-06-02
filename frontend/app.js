const QUERY = new URLSearchParams(window.location.search);
const DEFAULT_TIMELINE_UNLOCK_INTERVAL_MS = 5 * 60_000;
const TIMELINE_UNLOCK_INTERVAL_MS = Math.max(
  1000,
  Number(QUERY.get("timeline_ms")) || DEFAULT_TIMELINE_UNLOCK_INTERVAL_MS,
);
const configuredEndpoints = Array.isArray(window.SOCIETY_DATA_ENDPOINTS)
  ? window.SOCIETY_DATA_ENDPOINTS
  : [];
const DATA_ENDPOINTS = [
  QUERY.get("data"),
  ...configuredEndpoints,
].filter(Boolean);
const QUERY_EVENT_ENDPOINT = QUERY.get("events");
const HISTORY_STORAGE_KEY_PREFIX = "society.timeline.history.v2";
const LEGACY_HISTORY_STORAGE_KEY_PREFIXES = ["society.timeline.history.v1"];
const RELATION_VISUAL_GAMMA = 0.85;
const LAYOUT_LINK_VISUAL_MIN = 0.70;

const GROUP_COLORS = {
  alpha: "#0e8a82",
  verifier: "#2867a5",
  infra: "#3d8b4d",
  rescue: "#c9821e",
  archive: "#7c695a",
  bridge: "#cf4e54",
  orbit: "#6f7f8f",
};

const app = {
  snapshots: [],
  snapshotIndex: 0,
  selectedId: null,
  hoveredId: null,
  width: 0,
  height: 0,
  dpr: 1,
  nodes: [],
  links: [],
  nodeById: new Map(),
  relationByPair: new Map(),
  animationHandle: null,
  lastFrame: 0,
  edgeThreshold: 0.94,
  showEdges: true,
  needsResize: true,
  resetRequested: false,
  datasetSource: null,
  pollTimer: null,
  eventSource: null,
  refreshQueued: false,
  pollIntervalMs: 0,
  liveError: null,
  lastLoadedAt: null,
  detailTab: "profile",
  modelCallCounters: new Map(),
  modelPulses: new Map(),
  runtimeStartedAt: null,
  watchTimer: null,
  autoFocus: true,
  lastAutoFocusAt: -12_000,
  lastUserSelectionAt: 0,
  liveSnapshotLimit: 180,
  resetInFlight: false,
  timelineOpenedAt: Date.now(),
  timelineUnlockedMax: 0,
  timelineUnlockTimer: null,
};

const dom = {
  canvas: document.querySelector("#societyMap"),
  tooltip: document.querySelector("#agentTooltip"),
  mainlineText: document.querySelector("#mainlineText"),
  worldStats: document.querySelector("#worldStats"),
  mapTitle: document.querySelector("#mapTitle"),
  detailKicker: document.querySelector("#detailKicker"),
  detailTitle: document.querySelector("#detailTitle"),
  detailContent: document.querySelector("#detailContent"),
  clearSelection: document.querySelector("#clearSelection"),
  timelineRange: document.querySelector("#timelineRange"),
  timelineStep: document.querySelector("#timelineStep"),
  timelineMeta: document.querySelector("#timelineMeta"),
  keyEvents: document.querySelector("#keyEvents"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summaryExcerpt: document.querySelector("#summaryExcerpt"),
  openSummary: document.querySelector("#openSummary"),
  summaryDialog: document.querySelector("#summaryDialog"),
  summaryDialogTitle: document.querySelector("#summaryDialogTitle"),
  summaryDialogBody: document.querySelector("#summaryDialogBody"),
  closeSummary: document.querySelector("#closeSummary"),
  edgeThreshold: document.querySelector("#edgeThreshold"),
  showEdges: document.querySelector("#showEdges"),
  fitMap: document.querySelector("#fitMap"),
  resetSociety: document.querySelector("#resetSociety"),
  dataSourceBadge: document.querySelector("#dataSourceBadge"),
  autoFocus: document.querySelector("#autoFocus"),
  watchElapsed: document.querySelector("#watchElapsed"),
  watchTarget: document.querySelector("#watchTarget"),
  pulseMeters: document.querySelector("#pulseMeters"),
  liveHeat: document.querySelector("#liveHeat"),
  spotlightCard: document.querySelector("#spotlightCard"),
  watchQueue: document.querySelector("#watchQueue"),
  liveFeed: document.querySelector("#liveFeed"),
};

const ctx = dom.canvas.getContext("2d", { alpha: true });

bindUi();
loadSocietyData().then((dataset) => {
  app.datasetSource = dataset.source || {
    kind: "demo",
    label: "内置示例数据",
  };
  app.lastLoadedAt = app.datasetSource.kind === "real" ? new Date() : null;
  app.snapshots = dataset.snapshots.map(normalizeSnapshot).sort((a, b) => a.step - b.step);
  if (!app.snapshots.length) {
    app.snapshots = buildDemoDataset().snapshots.map(normalizeSnapshot);
  }
  discardLegacyTimelineHistory();
  loadPersistedTimelineHistory();
  primeModelCallCounters(app.snapshots.at(-1));
  app.runtimeStartedAt = inferRuntimeStartedAt(dataset, app.snapshots);
  app.timelineOpenedAt = Date.now();
  selectSnapshot(defaultTimelineIndex());
  resizeCanvas();
  startRealtimePolling(dataset);
  startTimelineUnlockClock();
  window.addEventListener("resize", () => {
    app.needsResize = true;
  });
  startWatchClock();
  app.animationHandle = requestAnimationFrame(loop);
});

async function loadSocietyData() {
  for (const endpoint of DATA_ENDPOINTS) {
    const dataset = await loadDatasetFromEndpoint(endpoint);
    if (dataset) {
      return dataset;
    }
  }
  const dataset = buildDemoDataset();
  dataset.source = {
    kind: "demo",
    label: "内置示例数据",
  };
  return dataset;
}

async function loadDatasetFromEndpoint(endpoint) {
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json();
    app.liveError = null;
    const dataset = normalizeDataset(value);
    dataset.source = {
      kind: "real",
      label: value?.metadata?.source_label || value?.source_label || endpoint,
      endpoint,
      live: Boolean(value?.metadata?.live),
      pollIntervalMs: Number(value?.metadata?.poll_interval_ms || 0),
      eventEndpoint: value?.metadata?.events_endpoint || QUERY_EVENT_ENDPOINT || inferredEventEndpoint(endpoint),
      controlEndpointTemplate: value?.metadata?.control_endpoint_template || "",
      resetEndpoint: value?.metadata?.reset_endpoint || "",
      runtimeStartedAt: value?.metadata?.runtime_started_at || value?.metadata?.runtimeStartedAt || "",
      runtimeInstanceId: value?.metadata?.runtime_instance_id || "",
    };
    return dataset;
  } catch (error) {
    app.liveError = String(error?.message || error);
    return null;
  }
}

function startRealtimePolling(dataset) {
  const endpoint = dataset.source?.endpoint;
  if (!endpoint || dataset.source?.kind !== "real") return;
  if (dataset.source?.eventEndpoint && startRealtimeEvents(dataset.source.eventEndpoint, endpoint)) {
    renderDataSource();
    return;
  }
  const interval = requestedPollInterval(dataset);
  if (!interval) return;
  app.pollIntervalMs = interval;
  window.clearInterval(app.pollTimer);
  app.pollTimer = window.setInterval(() => {
    refreshRealtimeDataset(endpoint);
  }, interval);
  renderDataSource();
}

function startRealtimeEvents(eventEndpoint, snapshotEndpoint) {
  if (!window.EventSource || !eventEndpoint || !snapshotEndpoint) return false;
  window.clearInterval(app.pollTimer);
  app.pollIntervalMs = 0;
  app.eventSource?.close();
  app.eventSource = new EventSource(eventEndpoint);
  app.eventSource.addEventListener("society.ready", () => {
    app.liveError = null;
    app.lastLoadedAt = new Date();
    renderDataSource();
  });
  app.eventSource.addEventListener("society.event", () => {
    app.liveError = null;
    queueRealtimeRefresh(snapshotEndpoint);
  });
  app.eventSource.onerror = () => {
    app.liveError = "event stream disconnected";
    renderDataSource();
  };
  return true;
}

function queueRealtimeRefresh(endpoint) {
  if (app.refreshQueued) return;
  app.refreshQueued = true;
  window.setTimeout(() => {
    app.refreshQueued = false;
    refreshRealtimeDataset(endpoint);
  }, 120);
}

function inferredEventEndpoint(endpoint) {
  try {
    const url = new URL(endpoint, window.location.href);
    if (url.pathname === "/api/society/snapshot") {
      url.pathname = "/api/society/events";
      url.search = "";
      return url.toString();
    }
  } catch {
    return "";
  }
  return "";
}

async function refreshRealtimeDataset(endpoint) {
  const dataset = await loadDatasetFromEndpoint(endpoint);
  if (!dataset?.snapshots?.length) {
    renderDataSource();
    return;
  }
  const wasAtLatest = app.snapshotIndex >= unlockedTimelineMax();
  const incoming = dataset.snapshots.map(normalizeSnapshot).sort((a, b) => a.step - b.step);
  triggerModelCallPulses(incoming.at(-1));
  const incomingStartedAt = inferRuntimeStartedAt(dataset, incoming);
  const runtimeChanged = runtimeInstanceKey(dataset.source) !== runtimeInstanceKey(app.datasetSource);
  app.datasetSource = dataset.source;
  if (Number.isFinite(incomingStartedAt)) {
    app.runtimeStartedAt = incomingStartedAt;
  }
  if (runtimeChanged) {
    clearPersistedTimelineHistory();
    app.snapshots = incoming;
    app.timelineOpenedAt = Date.now();
    primeModelCallCounters(incoming.at(-1));
  } else {
    app.snapshots = mergeRealtimeSnapshots(app.snapshots, incoming);
  }
  persistTimelineHistory();
  app.lastLoadedAt = new Date();
  if (wasAtLatest) {
    selectSnapshot(defaultTimelineIndex());
  } else {
    app.snapshotIndex = clamp(app.snapshotIndex, 0, unlockedTimelineMax());
    updateTimelineRange();
    renderSnapshot();
  }
}

function mergeRealtimeSnapshots(existing, incoming) {
  if (!existing.length) return incoming;
  const merged = [...existing];
  for (const snapshot of incoming) {
    const last = merged.at(-1);
    if (!last || snapshot.step > last.step) {
      merged.push(snapshot);
      continue;
    }
    const sameStepIndex = merged.findIndex((item) => item.step === snapshot.step);
    if (sameStepIndex >= 0) {
      merged[sameStepIndex] = snapshot;
    } else if (last) {
      merged[merged.length - 1] = snapshot;
    }
  }
  return merged
    .sort((a, b) => a.step - b.step)
    .slice(-app.liveSnapshotLimit);
}

function historyStorageKey(source = app.datasetSource) {
  const instance = runtimeInstanceKey(source);
  const sourceId = [source?.endpoint || source?.label || source?.kind || "default", instance]
    .filter(Boolean)
    .join("#");
  return `${HISTORY_STORAGE_KEY_PREFIX}:${encodeURIComponent(sourceId)}`;
}

function runtimeInstanceKey(source) {
  return source?.runtimeInstanceId || source?.runtimeStartedAt || "";
}

function loadPersistedTimelineHistory() {
  try {
    const raw = window.localStorage.getItem(historyStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const savedSnapshots = Array.isArray(parsed) ? parsed : parsed?.snapshots;
    if (!Array.isArray(savedSnapshots) || !savedSnapshots.length) return;
    if (!Array.isArray(parsed) && parsed.runtimeInstanceKey !== runtimeInstanceKey(app.datasetSource)) return;
    const saved = savedSnapshots.map(normalizeSnapshot).sort((a, b) => a.step - b.step);
    app.snapshots = mergeRealtimeSnapshots(saved, app.snapshots);
  } catch {
    // ignore storage errors
  }
}

function persistTimelineHistory() {
  try {
    window.localStorage.setItem(
      historyStorageKey(),
      JSON.stringify({
        runtimeInstanceKey: runtimeInstanceKey(app.datasetSource),
        storedAt: new Date().toISOString(),
        snapshots: app.snapshots.slice(-60),
      }),
    );
  } catch {
    // ignore storage quota / privacy errors
  }
}

function discardLegacyTimelineHistory() {
  clearPersistedTimelineHistory(LEGACY_HISTORY_STORAGE_KEY_PREFIXES);
}

function clearPersistedTimelineHistory(prefixes = [HISTORY_STORAGE_KEY_PREFIX, ...LEGACY_HISTORY_STORAGE_KEY_PREFIXES]) {
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (prefixes.some((prefix) => key?.startsWith(`${prefix}:`))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore storage errors
  }
}

function requestedPollInterval(dataset) {
  if (QUERY.get("poll") === "0") return 0;
  const queryPoll = Number(QUERY.get("poll"));
  if (Number.isFinite(queryPoll) && queryPoll > 0) return Math.max(500, queryPoll);
  const metadataPoll = Number(dataset.source?.pollIntervalMs || 0);
  if (Number.isFinite(metadataPoll) && metadataPoll > 0) return Math.max(500, metadataPoll);
  if (String(dataset.source?.endpoint || "").includes("/api/")) return 2000;
  return 0;
}

function normalizeDataset(value) {
  if (Array.isArray(value)) {
    return { snapshots: value, metadata: {} };
  }

  if (value?.snapshots && Array.isArray(value.snapshots)) {
    return { ...value, metadata: value.metadata || {} };
  }

  if (value?.current) {
    return {
      metadata: value.metadata || {},
      snapshots: [value.current, ...(value.snapshots || [])],
    };
  }

  if (value?.collaboration || value?.society || value?.reward_oracle) {
    return { metadata: value.metadata || {}, snapshots: [snapshotFromRuntimeSummary(value)] };
  }

  return { metadata: {}, snapshots: [] };
}

function snapshotFromRuntimeSummary(raw) {
  const collaboration = raw.collaboration || raw;
  const society = raw.society || {};
  const reward = raw.reward_oracle || {};
  const accounts = new Map((society.accounts || []).map((account) => [account.agent_id, account]));
  const localAgents = collaboration.agents || [];
  const remoteAgents = collaboration.remote_agents || [];
  const threads = collaboration.threads || {};
  const agents = [...localAgents, ...remoteAgents].map((agent, index) => {
    const account = accounts.get(agent.id) || {};
    const energy = Number(account.available ?? account.balance ?? 0);
    const maxEnergy = Math.max(Number(account.initial_energy ?? account.balance ?? energy), energy, 1);
    const lifecycle = normalizeLifecycle(account.lifecycle || agent.status, energy, maxEnergy);
    const thread = agent.thread || threads[agent.id] || null;
    return {
      id: agent.id,
      threadId: agent.thread_id || thread?.thread_id || agent.id,
      name: agent.name || agent.id,
      role: agent.role || agent.location || "agent",
      goal: agent.goal || "",
      lifecycle,
      status: agent.status || lifecycle,
      energy,
      maxEnergy,
      canAct: canAgentAct(agent.status, lifecycle),
      activity: thread?.state === "busy" || agent.status === "running" ? 1 : 0.42,
      thread,
      recentSummary: agent.last_summary || (agent.recent_summaries || []).at(-1) || "",
      incrementalSummaries: agent.recent_summaries || compact([agent.last_summary]),
      lifeMemory: memoryField(agent, "life") || agent.origin_story || "",
      workMemory: memoryField(agent, "work") || "",
      currentTask: activeTaskForAgent(agent, collaboration.jobs || [], thread),
      projects: projectsForAgent(agent, reward.sources || []),
      recentToolCalls: agent.recent_actions || [],
      recentTurn: agent.history_len || agent.latest_summary_id || 0,
      localTurn: agent.latest_summary_id || 0,
      modelCallCount: Number(agent.model_call_count ?? agent.modelCallCount ?? agent.history_len ?? agent.latest_summary_id ?? 0),
      group: groupForIndex(index),
      position: positionForIndex(index, Math.max(localAgents.length + remoteAgents.length, 1)),
    };
  });

  const pairs = collaboration.attention?.pairs || [];
  const relations = pairs
    .map((pair) => {
      const ids = String(pair.pair || "").split("->");
      return {
        source: ids[0],
        target: ids[1],
        score: Number(pair.score ?? 0),
      };
    })
    .filter((pair) => pair.source && pair.target && pair.source !== pair.target);

  const state = buildWorldState(
    agents,
    relations,
    society,
    reward,
    collaboration.collab_events || collaboration.events || [],
  );
  const step = runtimeStepFromSummary(raw, collaboration);

  return {
    step,
    createdAt: new Date().toISOString(),
    agents,
    relations,
    worldState: state,
    worldSummary: {
      step,
      createdAt: new Date().toISOString(),
      summaryText: runtimeSummaryText(agents, state, collaboration),
      previousWorldSummaryIds: [],
      inputAgentSummaryRange: {},
    },
    mainline: state.mainProjects.length
      ? `小镇正围绕 ${state.mainProjects.slice(0, 2).join("、")} 聚集。火种充足的居民冲在前线，火种吃紧的居民开始靠纽带寻找补给。`
      : "篝火刚刚点亮，居民们正在摸清彼此的位置、火种和第一批纽带。",
    keyEvents: eventTexts(collaboration.collab_events || collaboration.events || []),
  };
}

function runtimeStepFromSummary(raw, collaboration) {
  const startedAt = parseTimestamp(
    raw?.metadata?.runtime_started_at ||
      raw?.metadata?.runtimeStartedAt ||
      raw?.metadata?.started_at ||
      raw?.metadata?.startedAt,
  );
  if (Number.isFinite(startedAt) && startedAt > 0) {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  }
  const eventSeqs = (collaboration.collab_events || collaboration.events || [])
    .map((event) => Number(event?.seq))
    .filter(Number.isFinite);
  const maxEventSeq = eventSeqs.length ? Math.max(...eventSeqs) : NaN;
  const candidates = [
    collaboration.latest_seq,
    collaboration.next_event_seq,
    maxEventSeq,
    collaboration.trace?.count,
    raw.step,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function normalizeSnapshot(snapshot, index) {
  const agents = (snapshot.agents || []).map((agent, agentIndex) => {
    const maxEnergy = Math.max(
      Number(agent.maxEnergy ?? agent.max_energy ?? agent.initialEnergy ?? 100),
      Number(agent.energy ?? agent.balance ?? 0),
      1,
    );
    const energy = Number(agent.energy ?? agent.available ?? agent.balance ?? 0);
    const lifecycle = normalizeLifecycle(agent.lifecycle || agent.status, energy, maxEnergy);
    return {
      id: String(agent.id || agent.agent_id || `agent-${agentIndex + 1}`),
      threadId: agent.threadId || agent.thread_id || agent.thread?.thread_id || agent.id || "",
      name: agent.name || agent.agent_name || agent.id || `居民 ${agentIndex + 1}`,
      role: agent.role || agent.type || "resident",
      goal: agent.goal || "",
      lifecycle,
      status: agent.status || lifecycle,
      energy,
      maxEnergy,
      canAct: agent.canAct ?? canAgentAct(agent.status, lifecycle),
      activity: clamp(Number(agent.activity ?? agent.activeScore ?? 0.55), 0, 1),
      thread: agent.thread || null,
      recentSummary: agent.recentSummary || agent.recent_summary || agent.last_summary || "",
      incrementalSummaries:
        agent.incrementalSummaries ||
        agent.incremental_summaries ||
        agent.recent_summaries ||
        compact([agent.recentSummary, agent.last_summary]),
      lifeMemory: agent.lifeMemory || agent.life_memory || "",
      workMemory: agent.workMemory || agent.work_memory || "",
      skills: agent.skills || agent.skillMemory || agent.skill_memory || [],
      currentTask: agent.currentTask || agent.current_task || agent.thread?.current_prompt_preview || "",
      projects: normalizeProjects(agent.projects || agent.project || agent.currentProject || agent.current_project),
      recentToolCalls: agent.recentToolCalls || agent.recent_tool_calls || agent.recent_actions || [],
      recentTurn: Number(agent.recentTurn ?? agent.recent_turn ?? agent.history_len ?? 0),
      localTurn: Number(agent.localTurn ?? agent.local_turn ?? agent.latest_summary_id ?? 0),
      modelCallCount: modelCallCounter(agent),
      group: agent.group || agent.cluster || groupForIndex(agentIndex),
      position: normalizePosition(agent.position || agent.mapPosition || agent.map_position, agentIndex),
    };
  });

  const relations = symmetrizeRelations(snapshot.relations || snapshot.edges || snapshot.attentionPairs || []);
  const worldState =
    snapshot.worldState ||
    snapshot.world_state ||
    buildWorldState(agents, relations, snapshot.society || {}, snapshot.reward_oracle || {}, snapshot.events || []);

  return {
    id: snapshot.id || `snapshot-${index}`,
    step: Number(snapshot.step ?? index * 300),
    createdAt: snapshot.createdAt || snapshot.created_at || new Date().toISOString(),
    agents,
    relations,
    worldState,
    worldSummary: normalizeWorldSummary(snapshot.worldSummary || snapshot.world_summary, snapshot.step ?? index * 300),
    mainline: snapshot.mainline || snapshot.mainLine || snapshot.main_story || "",
    keyEvents: snapshot.keyEvents || snapshot.key_events || eventTexts(snapshot.events || []),
  };
}

function normalizeWorldSummary(summary, step) {
  if (!summary) {
    return {
      step,
      createdAt: new Date().toISOString(),
      previousWorldSummaryIds: [],
      inputAgentSummaryRange: {},
      summaryText: "【城镇记录】\n当前章节还没有生成记录。\n\n【居民与阵营】\n等待居民故事积累。\n\n【关键变化】\n暂无。\n\n【悬念】\n下一刻会出现新的盟友，还是有人先耗尽火种？",
    };
  }

  return {
    step: Number(summary.step ?? step),
    createdAt: summary.createdAt || summary.created_at || new Date().toISOString(),
    previousWorldSummaryIds:
      summary.previousWorldSummaryIds || summary.previous_world_summary_ids || summary.previousIds || [],
    inputAgentSummaryRange:
      summary.inputAgentSummaryRange || summary.input_agent_summary_range || summary.inputRange || {},
    summaryText: String(summary.summaryText || summary.summary_text || summary.text || summary || ""),
  };
}

function bindUi() {
  dom.edgeThreshold.value = String(app.edgeThreshold);
  dom.edgeThreshold.addEventListener("input", () => {
    app.edgeThreshold = Number(dom.edgeThreshold.value);
  });

  dom.showEdges.addEventListener("change", () => {
    app.showEdges = dom.showEdges.checked;
  });

  dom.fitMap.addEventListener("click", () => {
    app.resetRequested = true;
  });

  dom.resetSociety?.addEventListener("click", async () => {
    await resetSociety();
  });

  dom.autoFocus?.addEventListener("click", () => {
    app.autoFocus = !app.autoFocus;
    dom.autoFocus.classList.toggle("is-active", app.autoFocus);
  });

  dom.timelineRange.addEventListener("input", () => {
    selectSnapshot(Number(dom.timelineRange.value));
  });

  dom.clearSelection.addEventListener("click", () => {
    app.selectedId = null;
    app.lastUserSelectionAt = Date.now();
    renderDetail();
  });

  dom.openSummary.addEventListener("click", () => {
    const snapshot = currentSnapshot();
    dom.summaryDialogTitle.textContent = `第 ${formatNumber(displayChronicleStep(snapshot))} 刻城镇记录`;
    dom.summaryDialogBody.textContent = loreTextForDisplay(snapshot.worldSummary.summaryText);
    dom.summaryDialog.showModal();
  });

  dom.closeSummary.addEventListener("click", () => {
    dom.summaryDialog.close();
  });

  dom.canvas.addEventListener("mousemove", handlePointerMove);
  dom.canvas.addEventListener("mouseleave", () => {
    app.hoveredId = null;
    dom.tooltip.hidden = true;
  });
  dom.canvas.addEventListener("click", () => {
    if (app.hoveredId) {
      app.selectedId = app.hoveredId;
      app.detailTab = "profile";
      app.lastUserSelectionAt = Date.now();
      renderDetail();
    }
  });

  dom.watchQueue?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-agent-id]");
    const agentId = item?.dataset.agentId;
    if (!agentId) return;
    app.selectedId = agentId;
    app.detailTab = "profile";
    app.lastUserSelectionAt = Date.now();
    renderDetail();
  });

  dom.liveFeed?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-agent-id]");
    const agentId = item?.dataset.agentId;
    if (!agentId) return;
    app.selectedId = agentId;
    app.detailTab = "profile";
    app.lastUserSelectionAt = Date.now();
    renderDetail();
  });

  dom.spotlightCard?.addEventListener("click", () => {
    const agentId = dom.spotlightCard.dataset.agentId;
    if (!agentId) return;
    app.selectedId = agentId;
    app.detailTab = "profile";
    app.lastUserSelectionAt = Date.now();
    renderDetail();
  });

  dom.detailContent.addEventListener("submit", async (event) => {
    const form = event.target.closest(".agent-message-form");
    if (!form) return;
    event.preventDefault();
    await submitAgentMessage(form);
  });

  dom.detailContent.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-detail-tab]");
    if (!tab) return;
    app.detailTab = tab.dataset.detailTab || "profile";
    renderDetail();
  });
}

async function submitAgentMessage(form) {
  const agentId = form.dataset.agentId;
  const endpoint = controlEndpointForAgent(agentId);
  const textarea = form.querySelector("textarea[name='content']");
  const content = textarea?.value.trim() || "";
  if (!endpoint || !content) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        need_reply: Boolean(form.querySelector("input[name='needReply']")?.checked),
      }),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.error || `request failed: ${response.status}`);
    }
    textarea.value = "";
    app.liveError = null;
    if (app.datasetSource?.endpoint) {
      queueRealtimeRefresh(app.datasetSource.endpoint);
    }
  } catch (error) {
    app.liveError = String(error?.message || error);
    renderDataSource();
  } finally {
    button.disabled = false;
  }
}

async function resetSociety() {
  const endpoint = app.datasetSource?.resetEndpoint;
  if (!endpoint || app.resetInFlight) return;
  app.resetInFlight = true;
  renderDataSource();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.error || `reset failed: ${response.status}`);
    }
    if (app.eventSource) {
      app.eventSource.close();
      app.eventSource = null;
    }
    window.clearInterval(app.pollTimer);
    try {
      clearPersistedTimelineHistory();
    } catch {
      // ignore storage errors
    }
    const dataset = await loadDatasetFromEndpoint(app.datasetSource.endpoint);
    if (!dataset?.snapshots?.length) {
      throw new Error("reset succeeded but no snapshot could be loaded");
    }
    app.datasetSource = dataset.source;
    app.snapshots = dataset.snapshots.map(normalizeSnapshot).sort((a, b) => a.step - b.step);
    primeModelCallCounters(app.snapshots.at(-1));
    app.runtimeStartedAt = inferRuntimeStartedAt(dataset, app.snapshots);
    app.timelineOpenedAt = Date.now();
    dom.timelineRange.max = String(unlockedTimelineMax());
    dom.timelineRange.value = String(defaultTimelineIndex());
    selectSnapshot(defaultTimelineIndex());
    startRealtimePolling(dataset);
    startTimelineUnlockClock();
    app.liveError = null;
  } catch (error) {
    app.liveError = String(error?.message || error);
  } finally {
    app.resetInFlight = false;
    renderDataSource();
  }
}

function controlEndpointForAgent(agentId) {
  const template = app.datasetSource?.controlEndpointTemplate;
  if (!template || !agentId) return "";
  return template.replace("{agent_id}", encodeURIComponent(agentId));
}

function selectSnapshot(index) {
  app.snapshotIndex = clamp(index, 0, unlockedTimelineMax());
  updateTimelineRange();
  const snapshot = currentSnapshot();
  const previousNodes = app.nodeById;
  app.nodes = snapshot.agents.map((agent, agentIndex) => {
    const previous = previousNodes.get(agent.id);
    const node = {
      ...agent,
      x: previous?.x ?? 0,
      y: previous?.y ?? 0,
      vx: previous?.vx ?? 0,
      vy: previous?.vy ?? 0,
      targetX: previous?.targetX ?? 0,
      targetY: previous?.targetY ?? 0,
      radius: radiusForAgent(agent),
      color: colorForAgent(agent),
      order: agentIndex,
    };
    return node;
  });
  app.nodeById = new Map(app.nodes.map((node) => [node.id, node]));
  const sourceRelations = snapshot.relations
    .filter((relation) => app.nodeById.has(relation.source) && app.nodeById.has(relation.target))
    .map((relation) => ({ ...relation, score: clamp(Number(relation.score), 0, 1) }));
  app.links = buildDistanceRelations(app.nodes, sourceRelations);
  app.relationByPair = new Map();
  for (const relation of app.links) {
    app.relationByPair.set(pairKey(relation.source, relation.target), relation.score);
  }
  resizeCanvas();
  rebalanceNodeAnchors();
  if (!snapshot.agents.some((agent) => agent.id === app.selectedId)) {
    app.selectedId = null;
  }
  renderSnapshot();
  persistTimelineHistory();
}

function renderSnapshot() {
  const snapshot = currentSnapshot();
  const state = snapshot.worldState;
  const experience = deriveExperience(snapshot, previousSnapshot());
  updateTimelineRange();
  renderDataSource();
  dom.mainlineText.textContent = loreTextForDisplay(snapshot.mainline || mainlineFromSummary(snapshot.worldSummary.summaryText));
  dom.mapTitle.textContent = `${formatNumber(snapshot.agents.length)} 位居民`;
  dom.timelineStep.textContent = `第 ${formatNumber(displayChronicleStep(snapshot))} 刻`;
  dom.timelineMeta.textContent = timelineMetaText(snapshot);
  dom.canvas.parentElement.dataset.phase = experience.phase;
  renderStats(state);
  renderExperience(experience);
  renderEvents(snapshot.keyEvents);
  renderSummary(snapshot);
  renderDetail();
}

function updateTimelineRange() {
  const count = app.snapshots.length;
  const max = unlockedTimelineMax();
  app.snapshotIndex = clamp(app.snapshotIndex, 0, max);
  dom.timelineRange.max = String(max);
  dom.timelineRange.value = String(app.snapshotIndex);
  dom.timelineRange.disabled = max <= 0;
  dom.timelineRange.title = timelineRangeTitle(count, max);
}

function defaultTimelineIndex() {
  return unlockedTimelineMax();
}

function shouldGateTimeline() {
  const forced = QUERY.get("timeline_gate");
  if (forced === "0") return false;
  if (forced === "1") return true;
  return app.datasetSource?.kind === "demo";
}

function unlockedTimelineMax() {
  const count = app.snapshots.length;
  const fullMax = Math.max(0, count - 1);
  if (!shouldGateTimeline()) return fullMax;
  const elapsed = Math.max(0, Date.now() - app.timelineOpenedAt);
  return clamp(Math.floor(elapsed / TIMELINE_UNLOCK_INTERVAL_MS), 0, fullMax);
}

function timelineRangeTitle(count, max) {
  if (count <= 1) return "当前只有 1 个章节可查看";
  if (!shouldGateTimeline()) return `可拖动查看 ${count} 个章节`;
  const unlocked = Math.min(count, max + 1);
  if (max >= count - 1) return `全部 ${count} 个章节已解锁`;
  const elapsed = Math.max(0, Date.now() - app.timelineOpenedAt);
  const nextIn = TIMELINE_UNLOCK_INTERVAL_MS - (elapsed % TIMELINE_UNLOCK_INTERVAL_MS);
  return `已解锁 ${unlocked}/${count} 个章节，下一章约 ${formatDuration(nextIn)} 后开放`;
}

function timelineMetaText(snapshot) {
  const count = app.snapshots.length;
  const max = unlockedTimelineMax();
  const base = `${formatDate(snapshot.createdAt)} · 章节 ${app.snapshotIndex + 1}/${count}`;
  if (!shouldGateTimeline() || max >= count - 1) return base;
  return `${base} · 已解锁 ${Math.min(count, max + 1)}/${count}`;
}

function startTimelineUnlockClock() {
  window.clearInterval(app.timelineUnlockTimer);
  app.timelineUnlockedMax = unlockedTimelineMax();
  updateTimelineRange();
  if (!shouldGateTimeline() || app.snapshots.length <= 1) return;
  app.timelineUnlockTimer = window.setInterval(() => {
    const previousMax = app.timelineUnlockedMax;
    const nextMax = unlockedTimelineMax();
    const wasAtLatest = app.snapshotIndex >= previousMax;
    app.timelineUnlockedMax = nextMax;
    if (nextMax !== previousMax) {
      if (wasAtLatest) {
        selectSnapshot(nextMax);
      } else {
        updateTimelineRange();
        renderSnapshot();
      }
      return;
    }
    updateTimelineRange();
  }, 1000);
}

function primeModelCallCounters(snapshot) {
  app.modelCallCounters = new Map(
    (snapshot?.agents || []).map((agent) => [agent.id, modelCallCounter(agent)]),
  );
}

function triggerModelCallPulses(snapshot) {
  if (!snapshot?.agents?.length) return;
  const now = performance.now();
  for (const agent of snapshot.agents) {
    const count = modelCallCounter(agent);
    const previous = app.modelCallCounters.get(agent.id);
    if (Number.isFinite(previous) && count > previous) {
      app.modelPulses.set(agent.id, {
        startedAt: now,
        duration: 900,
      });
    }
    app.modelCallCounters.set(agent.id, count);
  }
}

function renderDataSource() {
  const source = app.datasetSource || { kind: "demo", label: "内置示例数据" };
  const isReal = source.kind === "real";
  const isLive = isReal && (app.pollIntervalMs > 0 || app.eventSource);
  dom.dataSourceBadge.textContent = app.eventSource
    ? "真实世界"
    : isLive
      ? "活跃世界"
      : isReal
        ? "真实存档"
        : "试玩存档";
  const runtime = app.runtimeStartedAt ? `\n系统起点: ${formatDate(app.runtimeStartedAt)}` : "";
  const loaded = app.lastLoadedAt ? `\n最近记录: ${app.lastLoadedAt.toLocaleTimeString()}` : "";
  const error = app.liveError ? `\n裂隙: ${app.liveError}` : "";
  const reset = app.resetInFlight ? "\n重置中: 处理中" : source.resetEndpoint ? "\n重置: 可用" : "";
  dom.dataSourceBadge.title = `${source.label || ""}${runtime}${loaded}${error}${reset}`;
  dom.dataSourceBadge.classList.toggle("real", isReal);
  if (dom.resetSociety) {
    dom.resetSociety.classList.toggle("is-active", Boolean(source.resetEndpoint));
    dom.resetSociety.disabled = !source.resetEndpoint || app.resetInFlight;
    dom.resetSociety.title = app.resetInFlight
      ? "重置处理中"
      : source.resetEndpoint
        ? "重置社会"
        : "当前数据源不支持重置";
  }
}

function previousSnapshot() {
  return app.snapshots[app.snapshotIndex - 1] || null;
}

function startWatchClock() {
  if (app.watchTimer) return;
  app.watchTimer = window.setInterval(() => {
    if (dom.watchElapsed) {
      const startedAt = app.runtimeStartedAt || Date.now();
      const elapsed = Date.now() - startedAt;
      dom.watchElapsed.textContent = formatDuration(elapsed);
    }
  }, 1000);
  renderWatchClock();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderWatchClock() {
  if (!dom.watchElapsed) return;
  const startedAt = app.runtimeStartedAt || Date.now();
  dom.watchElapsed.textContent = formatDuration(Date.now() - startedAt);
  if (dom.watchTarget) {
    const startedLabel = app.runtimeStartedAt ? formatDate(app.runtimeStartedAt) : "系统启动";
    dom.watchTarget.textContent = `系统起点 ${startedLabel}`;
  }
}

function inferRuntimeStartedAt(dataset, snapshots) {
  const metadata = dataset?.metadata || {};
  const metadataStarted =
    metadata.runtime_started_at ||
    metadata.runtimeStartedAt ||
    metadata.started_at ||
    metadata.startedAt ||
    metadata.created_at ||
    metadata.createdAt;
  const firstSnapshot = snapshots?.[0];
  const firstCreated = firstSnapshot?.createdAt || firstSnapshot?.created_at || firstSnapshot?.worldSummary?.createdAt || firstSnapshot?.worldSummary?.created_at;
  const runtime = dataset?.source?.runtime || null;
  const collab = runtime?.collaboration?.state || runtime?.collaboration || runtime?.state || null;
  const sessionCreated = runtime?.metadata?.created_at || runtime?.metadata?.createdAt || runtime?.session?.metadata?.created_at;
  const eventSeq = Number(collab?.next_event_seq || firstSnapshot?.step || 0);
  const eventWindowMs = eventSeq > 0 ? Math.max(0, eventSeq - 1) * 300_000 : 0;
  const candidates = [metadataStarted, sessionCreated, firstCreated]
    .map((value) => parseTimestamp(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length) return Math.min(...candidates);
  if (eventWindowMs && Number.isFinite(firstSnapshot?.createdAt ? Date.parse(firstSnapshot.createdAt) : NaN)) {
    return Date.parse(firstSnapshot.createdAt) - eventWindowMs;
  }
  return Date.now();
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return value * 1000;
  }
  const text = String(value).trim();
  if (!text) return NaN;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return parseTimestamp(numeric);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function deriveExperience(snapshot, previous) {
  const agents = snapshot.agents || [];
  const total = Math.max(agents.length, 1);
  const busyAgents = agents.filter(isAgentBusy);
  const lowEnergyAgents = agents
    .filter((agent) => agent.lifecycle !== "dead")
    .filter((agent) => agent.energy / Math.max(agent.maxEnergy, 1) <= 0.22)
    .sort((a, b) => a.energy / Math.max(a.maxEnergy, 1) - b.energy / Math.max(b.maxEnergy, 1));
  const errorAgents = agents.filter((agent) => String(agent.status || "").toLowerCase() === "error" || agent.thread?.last_error);
  const strongLinks = app.links.filter((relation) => relationVisualScore(relation) >= app.edgeThreshold);
  const previousEnergy = previous?.worldState?.totalEnergy ?? null;
  const energyDelta = Number.isFinite(previousEnergy) ? snapshot.worldState.totalEnergy - previousEnergy : 0;
  const heat = clamp(
    Math.round(
      busyAgents.length * 3.4 +
        lowEnergyAgents.length * 5.2 +
        errorAgents.length * 4.6 +
        strongLinks.length * 1.1 +
        Math.abs(energyDelta) / 70,
    ),
    0,
    99,
  );
  const phase = phaseName({ busyAgents, lowEnergyAgents, errorAgents, strongLinks, total });
  const queue = buildWatchQueue(snapshot, { busyAgents, lowEnergyAgents, errorAgents, strongLinks, energyDelta });
  const spotlight = chooseSpotlightAgent(snapshot, queue, busyAgents, lowEnergyAgents, errorAgents);
  return {
    heat,
    phase,
    busyAgents,
    lowEnergyAgents,
    errorAgents,
    strongLinks,
    energyDelta,
    queue,
    spotlight,
    feed: buildLiveFeed(snapshot, previous, queue, energyDelta),
  };
}

function renderExperience(experience) {
  if (dom.liveHeat) dom.liveHeat.textContent = formatNumber(experience.heat);
  if (dom.pulseMeters) {
    const delta = experience.energyDelta;
    const deltaText = delta === 0 ? "0" : `${delta > 0 ? "+" : ""}${formatNumber(delta)}`;
    dom.pulseMeters.innerHTML = [
      pulseCard("危机", experience.heat, experience.heat),
      pulseCard("开工", `${experience.busyAgents.length}/${currentSnapshot().agents.length}`, (experience.busyAgents.length / Math.max(currentSnapshot().agents.length, 1)) * 100),
      pulseCard("火种变化", deltaText, Math.min(100, Math.abs(delta) / 12), "相对上一条编年史快照的总火种变化"),
    ].join("");
  }
  renderSpotlight(experience.spotlight);
  renderWatchQueue(experience.queue);
  renderLiveFeed(experience.feed);
}

function pulseCard(label, value, percent, title = "") {
  return `
    <div class="pulse-card" ${title ? `title="${escapeHtml(title)}"` : ""}>
      <div class="pulse-label">${escapeHtml(label)}</div>
      <div class="pulse-value">${escapeHtml(value)}</div>
      <div class="pulse-bar"><div class="pulse-fill" style="width:${clamp(percent, 2, 100)}%"></div></div>
    </div>
  `;
}

function renderSpotlight(agent) {
  if (!dom.spotlightCard) return;
  if (!agent) {
    dom.spotlightCard.innerHTML = `
      <div class="spotlight-name"><span>暂无主角</span><span>--</span></div>
      <div class="spotlight-copy">等待下一刻。</div>
    `;
    dom.spotlightCard.removeAttribute("data-agent-id");
    return;
  }
  dom.spotlightCard.dataset.agentId = agent.id;
  dom.spotlightCard.innerHTML = `
    <div class="spotlight-name">
      <span>${escapeHtml(agent.name)}</span>
      <span>${escapeHtml(agentStatusLabel(agent))}</span>
    </div>
    <div class="spotlight-copy">${escapeHtml(shortText(agentSpotlightText(agent), 180))}</div>
  `;
}

function renderWatchQueue(items) {
  if (!dom.watchQueue) return;
  dom.watchQueue.innerHTML = items.length
    ? items
        .slice(0, 7)
        .map(
          (item) => `
            <button class="watch-item ${escapeHtml(item.kind)}" data-agent-id="${escapeHtml(item.agentId || "")}" type="button">
              <span class="watch-stripe"></span>
              <span>
                <span class="watch-title">
                  <span>${escapeHtml(item.title)}</span>
                  <span>${escapeHtml(item.meta || "")}</span>
                </span>
                <span class="watch-body">${escapeHtml(shortText(loreTextForDisplay(item.body || ""), 170))}</span>
              </span>
            </button>
          `,
        )
        .join("")
    : `<div class="feed-item"><div class="feed-title">营地平静</div><div class="feed-body">当前没有高危居民。</div></div>`;
}

function renderLiveFeed(items) {
  if (!dom.liveFeed) return;
  dom.liveFeed.innerHTML = items.length
    ? items
        .slice(0, 8)
        .map((item) => {
          const tag = item.agentId ? "button" : "div";
          const attrs = item.agentId ? ` type="button" data-agent-id="${escapeHtml(item.agentId)}"` : "";
          return `
            <${tag} class="feed-item"${attrs}>
              <div class="feed-title">
                <span>${escapeHtml(item.title)}</span>
                <span>${escapeHtml(item.meta || "")}</span>
              </div>
              <div class="feed-body">${escapeHtml(shortText(loreTextForDisplay(item.body || ""), 180))}</div>
            </${tag}>
          `;
        })
        .join("")
    : `<div class="feed-item"><div class="feed-title">暂无传闻</div><div class="feed-body">等待下一条城镇消息。</div></div>`;
}

function renderStats(state) {
  const stats = [
    ["居民", state.populationCount ?? state.aliveCount ?? 0],
    ["低火", state.dyingCount ?? 0],
    ["陨落", state.deadCount ?? 0],
    ["火种", state.totalEnergy ?? 0],
    ["筹码", state.circulatingTokens ?? state.tokenCount ?? 0],
    ["据点", state.repoCount ?? 0],
    ["声望", state.githubStars ?? 0],
    ["新增声望", state.recentStars ?? 0],
    ["凭证", state.rewardReceiptCount ?? 0],
    ["任务线", (state.mainProjects || []).length],
  ];

  dom.worldStats.innerHTML = stats
    .map(
      ([label, value]) => `
        <div class="stat-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value">${escapeHtml(formatStatValue(value))}</div>
        </div>
      `,
    )
    .join("");
}

function renderEvents(events) {
  const items = (events || []).map(eventTextForDisplay).filter(Boolean).slice(0, 8);
  dom.keyEvents.innerHTML = items.length
    ? items.map((event) => `<div class="event-pill">${escapeHtml(event)}</div>`).join("")
    : `<div class="event-pill">暂无新的传闻</div>`;
}

function renderSummary(snapshot) {
  const titleStep = displayChronicleStep(snapshot);
  dom.summaryTitle.textContent = `第 ${formatNumber(titleStep)} 刻记录`;
  dom.summaryExcerpt.textContent = summaryExcerpt(loreTextForDisplay(snapshot.worldSummary.summaryText), 260);
}

function renderDetail() {
  const snapshot = currentSnapshot();
  const agent = app.selectedId ? snapshot.agents.find((item) => item.id === app.selectedId) : null;
  if (!agent) {
    dom.detailKicker.textContent = "居民";
    dom.detailTitle.textContent = "未选择居民";
    dom.detailContent.innerHTML = `<div class="empty-state">定居点地图</div>`;
    return;
  }

  const statusClass = statusClassForAgent(agent);
  const energyPercent = Math.round((agent.energy / agent.maxEnergy) * 100);
  const projects = normalizeProjects(agent.projects);
  const summaries = (agent.incrementalSummaries || [])
    .slice(-5)
    .map((summary) => summarizeAgentText(summary, agent))
    .filter(Boolean);
  const skills = Array.isArray(agent.skills) ? agent.skills : splitLines(agent.skills);
  const relations = topRelations(agent.id, 6);
  const actionEvents = normalizeActionEvents(agent.recentToolCalls).slice(-5).reverse();
  const controlEndpoint = controlEndpointForAgent(agent.id);
  const activeTab = app.detailTab === "context" ? "context" : "profile";
  const lifeMemory = memoryField(agent, "life") || "暂无来历。";
  const workMemory = memoryField(agent, "work") || "暂无可用工作记忆。";

  dom.detailKicker.textContent = `居民 · ${agent.id}`;
  dom.detailTitle.textContent = agent.name;
  dom.detailContent.innerHTML = `
    <section class="character-sheet" style="--agent-color: ${escapeHtml(colorForAgent(agent))}">
      <div class="portrait-orb" aria-hidden="true">${escapeHtml(initials(agent.name))}</div>
      <div class="character-main">
        <div class="agent-name">${escapeHtml(agent.name)}</div>
        <div class="agent-role">${escapeHtml(agentSubtitle(agent))}</div>
        <div class="character-tags">
          <span class="status-pill ${escapeHtml(statusClass)}">${escapeHtml(agentStatusLabel(agent))}</span>
          <span class="mini-chip">火种 ${formatNumber(agent.energy)}/${formatNumber(agent.maxEnergy)}</span>
          <span class="mini-chip">刻 ${formatNumber(agent.localTurn || agent.recentTurn || 0)}</span>
        </div>
      </div>
    </section>

    <div class="micro-grid">
      <div class="micro-card">
        <div class="micro-label">行踪</div>
        <div class="micro-value">${escapeHtml(threadStateLabel(agent.thread?.state || agent.status || "unknown"))}</div>
      </div>
      <div class="micro-card">
        <div class="micro-label">纽带</div>
        <div class="micro-value">${formatNumber(relations.length)}</div>
      </div>
    </div>

    <div class="energy-meter compact-meter">
      <div class="meter-line">
        <span>生命火种</span>
        <strong>${clamp(energyPercent, 0, 100)}%</strong>
      </div>
      <div class="meter-track"><div class="meter-fill" style="width: ${clamp(energyPercent, 0, 100)}%"></div></div>
    </div>

    <div class="detail-tabs" role="tablist" aria-label="居民详情">
      <button class="detail-tab ${activeTab === "profile" ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === "profile"}" data-detail-tab="profile">人物卡</button>
      <button class="detail-tab ${activeTab === "context" ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === "context"}" data-detail-tab="context">行动牌</button>
    </div>

    ${
      activeTab === "profile"
        ? `
          <div class="profile-stack">
            ${memoryCard("来历", lifeMemory, "life")}
            ${memoryCard("手艺", workMemory, "work")}
            ${projects.length ? chipSection("任务线", projects) : ""}
            ${skills.length ? chipSection("能力", skills.slice(0, 12)) : ""}
            ${detailSection("近况", agentSummaryPreview(agent, 240) || "暂无记录")}
          </div>
        `
        : `
          <div class="context-stack">
            ${detailSection("正在做的事", agentCurrentWorkText(agent, actionEvents))}
            ${detailSection("工作脉络", threadSummary(agent, actionEvents))}
            ${controlEndpoint ? agentMessageForm(agent.id) : ""}
            ${
              summaries.length
                ? detailSection(
                    "最近记录",
                    summaries.map((summary) => `• ${summary}`).join("\n"),
                  )
                : ""
            }
            ${relationSection(relations)}
            ${actionEventSection(actionEvents)}
          </div>
        `
    }
  `;
}

function memoryCard(title, text, tone) {
  return `
    <section class="memory-card ${escapeHtml(tone)}">
      <div class="memory-label">${escapeHtml(title)}</div>
      <div class="memory-text">${escapeHtml(text)}</div>
    </section>
  `;
}

function agentSubtitle(agent) {
  if (agent.role && agent.role !== "resident" && agent.role !== "citizen") return agent.role;
  if (agent.lifecycle === "dead") return "沉默的居民";
  if (agent.status && agent.status !== agent.lifecycle) return `小镇居民 · ${threadStateLabel(agent.status)}`;
  return "小镇居民";
}

function statusClassForAgent(agent) {
  if (String(agent.status || "").toLowerCase() === "running" || agent.thread?.state === "busy") {
    return "status-running";
  }
  if (String(agent.status || "").toLowerCase() === "error" || agent.thread?.last_error) {
    return "status-error";
  }
  return `status-${agent.lifecycle}`;
}

function initials(name) {
  const text = String(name || "?").trim();
  return [...text].slice(0, 2).join("") || "?";
}

function agentCurrentWorkText(agent, actionEvents = []) {
  const task = meaningfulCurrentTask(agent);
  if (task) return task;
  const latestAction = newestActionEvent(agent, actionEvents);
  if (latestAction) return `${latestAction.title}：${latestAction.body}`;
  const summary = agentSummaryPreview(agent, 260);
  if (summary) return summary;
  return "还没有留下可读的工作记录。";
}

function meaningfulCurrentTask(agent) {
  const task =
    agent.currentTask ||
    agent.current_task ||
    agent.thread?.current_prompt_preview ||
    "";
  return workTextForDisplay(task, agent);
}

function workTextForDisplay(text, agent = null) {
  const value = cleanupRichText(text);
  if (!value) return "";
  const promptSummary = promptTextForDisplay(value);
  if (promptSummary) return promptSummary;
  const goal = cleanupRichText(agent?.goal || "");
  if (goal && value === goal) return "";
  if (looksLikeGenericGoal(value)) return "";
  return shortText(value, 360);
}

function promptTextForDisplay(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/你已经被放入一个正在展开的虚拟世界/.test(value) || /现在开始第一轮探索和工作/.test(value)) {
    return "刚进入虚拟小镇，正在寻找第一件具体工作：观察环境、联系同伴、记录线索，或推进一个可验证的小产物。";
  }
  if (/Build durable shared knowledge.*long-term problem.*conserving (?:energy|火种)/i.test(value)) {
    return "正在为一个可验证的长期问题搭建公共知识，并尽量节省火种。";
  }
  if (/Build a living \d+-agent society/i.test(value)) {
    return "正在让多位居民形成可观察、可协作的小镇社会。";
  }
  if (/(当前|现在).*(能量|火种)|(能量|火种).*(减少|消耗|变化)/.test(value)) {
    return shortText(value, 260);
  }
  return "";
}

function looksLikeGenericGoal(text) {
  const value = String(text || "");
  return /Build durable shared knowledge|Build a living \d+-agent society|long-term problem while conserving energy|project_alpha.*runtime_infra.*memory_archive/i.test(
    value,
  );
}

function newestActionEvent(agent, actionEvents = []) {
  if (actionEvents.length) return actionEvents[0];
  return normalizeActionEvents(agent.recentToolCalls).at(-1) || null;
}

function threadSummary(agent, actionEvents = []) {
  const thread = agent?.thread || null;
  const lines = [
    `工作线: ${thread?.thread_id || thread?.agent_id || agent?.threadId || agent?.id || "unknown"}`,
    `行踪: ${threadStateLabel(thread?.state || agent?.status || "unknown")}`,
  ];
  if (thread) {
    lines.push(`排队工作: ${formatNumber(thread.queue_depth || 0)}`);
    if (thread.current_job_id) lines.push(`当前工作: ${thread.current_job_id}`);
    const currentPrompt = workTextForDisplay(thread.current_prompt_preview || "", agent);
    if (currentPrompt) lines.push(`工作提示: ${currentPrompt}`);
    if (thread.last_started_at) lines.push(`最近开始: ${formatUnixTime(thread.last_started_at)}`);
    if (thread.last_completed_at) lines.push(`最近完成: ${formatUnixTime(thread.last_completed_at)}`);
    if (thread.last_error) lines.push(`裂隙: ${technicalErrorToLore(thread.last_error)}`);
  } else {
    lines.push("记录来源: 这份快照没有带回细粒度线程心跳，正在用最近记录和动作还原。");
  }
  const latestAction = newestActionEvent(agent, actionEvents);
  if (latestAction) lines.push(`最近动作: ${latestAction.title}`);
  const summary = agentSummaryPreview(agent, 180);
  if (summary) lines.push(`最近记录: ${summary}`);
  return lines.join("\n");
}

function agentMessageForm(agentId) {
  return `
    <form class="agent-message-form" data-agent-id="${escapeHtml(agentId)}">
      <textarea name="content" rows="3" placeholder="给这位居民留一条工作消息"></textarea>
      <div class="agent-message-actions">
        <label class="toggle-field compact-toggle">
          <input name="needReply" type="checkbox" />
          <span>等待回信</span>
        </label>
        <button class="text-button" type="submit">发送</button>
      </div>
    </form>
  `;
}

function detailSection(title, text) {
  return `
    <section class="detail-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="detail-text">${escapeHtml(rewriteForDisplay(text))}</div>
    </section>
  `;
}

function chipSection(title, values) {
  return `
    <section class="detail-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="chip-row">
        ${values.map((value) => `<span class="chip">${escapeHtml(String(value))}</span>`).join("")}
      </div>
    </section>
  `;
}

function relationSection(relations) {
  if (!relations.length) return "";
  return `
    <section class="detail-section">
      <h3>近邻纽带</h3>
      <div class="relation-list">
        ${relations
          .map(
            (relation) => `
              <div class="relation-item">
                <div class="relation-title">
                  <span>${escapeHtml(relation.agent.name)}</span>
                  <span>强度 ${Math.round(relation.score * 100)}%</span>
                </div>
                <div class="relation-body">${escapeHtml(agentSummaryPreview(relation.agent, 150) || relation.agent.currentTask || "")}</div>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function actionEventSection(events) {
  if (!events.length) return "";
  return `
    <section class="detail-section action-section">
      <h3>最近行动</h3>
      <div class="event-log">
        ${events.map(actionEventItem).join("")}
      </div>
    </section>
  `;
}

function actionEventItem(event) {
  const kind = actionKindClass(event.kind);
  const rawBlock = shouldShowActionRaw(event)
    ? `
        <details class="action-raw">
          <summary>原始记录</summary>
          <pre>${escapeHtml(shortText(event.raw, 1400))}</pre>
        </details>
      `
    : "";
  return `
    <div class="action-event action-${escapeHtml(kind)}">
      <div class="action-marker" aria-hidden="true">${escapeHtml(actionIcon(kind))}</div>
      <div class="action-content">
        <div class="action-head">
          <span class="action-title">${escapeHtml(event.title)}</span>
          <span class="action-status ${escapeHtml(actionStatusClass(event.status))}">${escapeHtml(event.statusLabel)}</span>
        </div>
        <div class="action-body">${escapeHtml(event.body)}</div>
        <div class="action-meta">
          <span>${escapeHtml(actionKindLabel(kind))}</span>
          <span>${escapeHtml(event.sourceLabel)}</span>
        </div>
        ${rawBlock}
      </div>
    </div>
  `;
}

function loop(timestamp) {
  if (app.needsResize) {
    resizeCanvas();
    app.needsResize = false;
  }
  if (app.resetRequested) {
    resetNodePositions();
    app.resetRequested = false;
  }

  maybeAutoFocus(timestamp);
  const delta = Math.min(32, timestamp - app.lastFrame || 16);
  app.lastFrame = timestamp;
  tickLayout(delta / 16.67);
  draw(timestamp);
  app.animationHandle = requestAnimationFrame(loop);
}

function maybeAutoFocus(timestamp) {
  if (!app.autoFocus || !app.nodes.length) return;
  if (Date.now() - app.lastUserSelectionAt < 45_000) return;
  if (timestamp - app.lastAutoFocusAt < 12_000) return;
  app.lastAutoFocusAt = timestamp;
  const snapshot = currentSnapshot();
  const experience = deriveExperience(snapshot, previousSnapshot());
  const focus = experience.spotlight || mostActiveAgent(snapshot.agents);
  if (!focus || focus.id === app.selectedId) return;
  app.selectedId = focus.id;
  app.detailTab = "profile";
  renderDetail();
}

function resizeCanvas() {
  const rect = dom.canvas.parentElement.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const width = Math.max(320, rect.width);
  const height = Math.max(320, rect.height);
  if (width !== app.width || height !== app.height || dpr !== app.dpr) {
    app.width = width;
    app.height = height;
    app.dpr = dpr;
    dom.canvas.width = Math.floor(width * dpr);
    dom.canvas.height = Math.floor(height * dpr);
    dom.canvas.style.width = `${width}px`;
    dom.canvas.style.height = `${height}px`;
  }
  setNodeTargets();
  rebalanceNodeAnchors();
}

function setNodeTargets() {
  if (!app.nodes.length) return;

  const positions = app.nodes.map((node) => normalizePosition(node.position, node.order));
  const bounds = boundsFromPositions(positions);
  const spread = layoutSpread();
  const centerX = app.width / 2;
  const centerY = app.height / 2;

  for (let i = 0; i < app.nodes.length; i += 1) {
    const node = app.nodes[i];
    const pos = positions[i];
    const centeredX = bounds.width > 0 ? (pos.x - bounds.minX - bounds.width / 2) / Math.max(bounds.width / 2, 0.01) : 0;
    const centeredY = bounds.height > 0 ? (pos.y - bounds.minY - bounds.height / 2) / Math.max(bounds.height / 2, 0.01) : 0;
    const target = {
      x: centerX + centeredX * spread.x,
      y: centerY + centeredY * spread.y,
    };
    node.targetX = clamp(target.x, node.radius + 16, app.width - node.radius - 16);
    node.targetY = clamp(target.y, node.radius + 16, app.height - node.radius - 16);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || (node.x === 0 && node.y === 0)) {
      node.x = node.targetX;
      node.y = node.targetY;
    }
  }
}

function rebalanceNodeAnchors() {
  if (!app.nodes.length) return;
  for (const node of app.nodes) {
    if (!Number.isFinite(node.targetX) || !Number.isFinite(node.targetY)) continue;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || (node.x === 0 && node.y === 0)) {
      node.x = node.targetX;
      node.y = node.targetY;
    }
  }
}

function resetNodePositions() {
  for (const node of app.nodes) {
    node.x = node.targetX;
    node.y = node.targetY;
    node.vx = 0;
    node.vy = 0;
  }
}

function tickLayout(dt) {
  if (!app.nodes.length) return;
  const width = app.width;
  const height = app.height;
  const centerX = width / 2;
  const centerY = height / 2;

  for (const node of app.nodes) {
    node.radius = radiusForAgent(node);
    node.color = colorForAgent(node);
    const anchorStrength = node.lifecycle === "dead" ? 0.004 : 0.018;
    node.vx += (node.targetX - node.x) * anchorStrength * dt;
    node.vy += (node.targetY - node.y) * anchorStrength * dt;
    node.vx += (centerX - node.x) * 0.0008 * dt;
    node.vy += (centerY - node.y) * 0.0008 * dt;
    if (node.lifecycle === "dead") {
      node.vy += 0.045 * dt;
      node.vx += Math.sign(node.x - centerX || 1) * 0.014 * dt;
    }
  }

  for (let i = 0; i < app.nodes.length; i += 1) {
    const a = app.nodes[i];
    for (let j = i + 1; j < app.nodes.length; j += 1) {
      const b = app.nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distanceSq = dx * dx + dy * dy;
      const distance = Math.sqrt(distanceSq);
      const nx = dx / distance;
      const ny = dy / distance;
      const minDistance = a.radius + b.radius + 5;
      const repulsion = (a.lifecycle === "dead" || b.lifecycle === "dead" ? 520 : 760) / Math.max(80, distanceSq);
      a.vx -= nx * repulsion * dt;
      a.vy -= ny * repulsion * dt;
      b.vx += nx * repulsion * dt;
      b.vy += ny * repulsion * dt;

      if (distance < minDistance) {
        const push = (minDistance - distance) * 0.055;
        a.vx -= nx * push * dt;
        a.vy -= ny * push * dt;
        b.vx += nx * push * dt;
        b.vy += ny * push * dt;
      }
    }
  }

  for (const link of app.links) {
    const visualScore = relationVisualScore(link);
    if (visualScore < LAYOUT_LINK_VISUAL_MIN) continue;
    const source = app.nodeById.get(link.source);
    const target = app.nodeById.get(link.target);
    if (!source || !target) continue;
    const dx = target.x - source.x || 0.01;
    const dy = target.y - source.y || 0.01;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const ideal = layoutLinkDistance(visualScore, source, target);
    const strength = (distance - ideal) * 0.0016 * visualScore;
    const lifeFactor = source.lifecycle === "dead" || target.lifecycle === "dead" ? 0.2 : 1;
    const fx = (dx / distance) * strength * lifeFactor * dt;
    const fy = (dy / distance) * strength * lifeFactor * dt;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  for (const node of app.nodes) {
    node.vx *= 0.9;
    node.vy *= 0.9;
    node.x += clamp(node.vx, -14, 14) * dt;
    node.y += clamp(node.vy, -14, 14) * dt;
    const margin = node.radius + 8;
    node.x = clamp(node.x, margin, width - margin);
    node.y = clamp(node.y, margin, height - margin);
  }
}

function draw(timestamp) {
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  ctx.clearRect(0, 0, app.width, app.height);
  drawEdges();
  drawNodes(timestamp);
}

function drawEdges() {
  if (!app.showEdges) return;
  ctx.save();
  ctx.lineCap = "round";
  const selected = app.selectedId;
  for (const link of app.links) {
    const isSelected = selected && (link.source === selected || link.target === selected);
    const visualScore = relationVisualScore(link);
    if (visualScore < app.edgeThreshold && !isSelected) continue;
    const source = app.nodeById.get(link.source);
    const target = app.nodeById.get(link.target);
    if (!source || !target) continue;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    const alpha = 0.1 + visualScore * 0.34;
    ctx.strokeStyle = isSelected ? "rgba(219, 160, 72, 0.72)" : `rgba(240, 217, 169, ${alpha})`;
    ctx.lineWidth = isSelected ? 2 : 0.55 + visualScore * 1.85;
    ctx.stroke();
  }
  ctx.restore();
}

function drawNodes(timestamp) {
  const sorted = [...app.nodes].sort((a, b) => a.radius - b.radius);
  const selectedId = app.selectedId;
  const hoveredId = app.hoveredId;
  for (const node of sorted) {
    const selected = node.id === selectedId;
    const hovered = node.id === hoveredId;
    const pulse = node.lifecycle === "exhausted" || node.lifecycle === "dying"
      ? 1 + Math.sin(timestamp / 260) * 0.08
      : 1;
    const radius = node.radius * pulse + (hovered ? 2 : 0);
    const modelPulse = modelPulseStrength(node, timestamp);
    ctx.save();
    ctx.translate(node.x, node.y);

    if (selected || hovered) {
      ctx.beginPath();
      ctx.arc(0, 0, radius + (selected ? 9 : 6), 0, Math.PI * 2);
      ctx.fillStyle = selected ? "rgba(219, 160, 72, 0.18)" : "rgba(56, 184, 174, 0.12)";
      ctx.fill();
      ctx.strokeStyle = selected ? "rgba(219, 160, 72, 0.78)" : "rgba(56, 184, 174, 0.46)";
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }

    if (modelPulse > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, radius + 8 + modelPulse * 8, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(56, 184, 174, ${0.1 + modelPulse * 0.52})`;
      ctx.lineWidth = 1.5 + modelPulse * 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, radius + 2 + modelPulse * 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(92, 143, 212, ${0.05 + modelPulse * 0.18})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    if (node.lifecycle === "dead") {
      ctx.fillStyle = "rgba(144,139,124,0.42)";
      ctx.fill();
      ctx.strokeStyle = "rgba(240, 217, 169, 0.34)";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.66 + node.activity * 0.34;
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(255,244,215,0.92)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (node.lifecycle === "exhausted" || node.lifecycle === "dying") {
      ctx.beginPath();
      ctx.arc(0, 0, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(201, 130, 30, ${0.38 + Math.sin(timestamp / 260) * 0.18})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (isAgentBusy(node)) {
      const sweep = (timestamp / 900 + node.order * 0.37) % (Math.PI * 2);
      ctx.beginPath();
      ctx.arc(0, 0, radius + 6, sweep, sweep + Math.PI * 1.34);
      ctx.strokeStyle = "rgba(219, 160, 72, 0.78)";
      ctx.lineWidth = 2.4;
      ctx.stroke();
      drawBusyFlag(radius);
    }

    if (node.lifecycle !== "dead") {
      const energyRatio = clamp(node.energy / Math.max(node.maxEnergy, 1), 0, 1);
      ctx.beginPath();
      ctx.arc(-radius * 0.28, -radius * 0.28, Math.max(2, radius * 0.16), 0, Math.PI * 2);
      ctx.fillStyle = energyRatio < 0.22 ? "#d96568" : "#f7eedc";
      ctx.fill();
    }

    if (selected || hovered || node.energy > node.maxEnergy * 0.86) {
      drawNodeLabel(node, radius);
    }

    ctx.restore();
  }
}

function modelPulseStrength(node, timestamp) {
  const pulse = app.modelPulses.get(node.id);
  if (!pulse) return 0;
  const elapsed = timestamp - pulse.startedAt;
  if (elapsed < 0) return 0;
  if (elapsed > pulse.duration) {
    app.modelPulses.delete(node.id);
    return 0;
  }
  const progress = elapsed / pulse.duration;
  return Math.sin(Math.PI * progress) ** 2;
}

function drawNodeLabel(node, radius) {
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const label = node.name.length > 20 ? `${node.name.slice(0, 18)}…` : node.name;
  const width = ctx.measureText(label).width + 12;
  const x = -width / 2;
  const y = radius + 8;
  ctx.fillStyle = "rgba(255, 244, 215, 0.94)";
  roundRect(ctx, x, y, width, 22, 7);
  ctx.fill();
  ctx.strokeStyle = "rgba(86, 63, 30, 0.34)";
  ctx.stroke();
  ctx.fillStyle = "#2a2118";
  ctx.fillText(label, 0, y + 5);
}

function drawBusyFlag(radius) {
  const mastX = radius * 0.42;
  const mastY = -radius - 10;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 244, 215, 0.84)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(mastX, mastY);
  ctx.lineTo(mastX, mastY + 15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(mastX, mastY);
  ctx.lineTo(mastX + 12, mastY + 4);
  ctx.lineTo(mastX, mastY + 8);
  ctx.closePath();
  ctx.fillStyle = "rgba(217, 101, 104, 0.94)";
  ctx.fill();
  ctx.restore();
}

function handlePointerMove(event) {
  const rect = dom.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const node = nearestNode(x, y);
  app.hoveredId = node?.id || null;
  if (!node) {
    dom.tooltip.hidden = true;
    return;
  }
  renderTooltip(node, x, y);
}

function nearestNode(x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of app.nodes) {
    const dx = node.x - x;
    const dy = node.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const hitRadius = Math.max(node.radius + 8, 12);
    if (distance <= hitRadius && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function renderTooltip(node, x, y) {
  const projects = normalizeProjects(node.projects);
  const glimpse = summaryExcerpt(node.lifeMemory || node.recentSummary || "暂无记忆", 90);
  dom.tooltip.innerHTML = `
    <div class="tooltip-title">${escapeHtml(node.name)}</div>
    <div class="tooltip-row"><span>火种</span><strong>${formatNumber(node.energy)}</strong></div>
    <div class="tooltip-row"><span>行踪</span><strong>${escapeHtml(agentStatusLabel(node))}</strong></div>
    <div class="tooltip-row"><span>任务</span><strong>${escapeHtml(projects[0] || "无")}</strong></div>
    <div class="tooltip-summary">${escapeHtml(glimpse)}</div>
  `;
  const bounds = dom.canvas.parentElement.getBoundingClientRect();
  const tooltipRect = { width: 300, height: 170 };
  const left = clamp(x + 14, 10, bounds.width - tooltipRect.width - 10);
  const top = clamp(y + 14, 10, bounds.height - tooltipRect.height - 10);
  dom.tooltip.style.left = `${left}px`;
  dom.tooltip.style.top = `${top}px`;
  dom.tooltip.hidden = false;
}

function currentSnapshot() {
  return app.snapshots[app.snapshotIndex] || app.snapshots[0];
}

function displayChronicleStep(snapshot) {
  const index = app.snapshots.indexOf(snapshot);
  if (usesUiChronicleSteps()) {
    return Math.max(0, index >= 0 ? index : app.snapshotIndex);
  }
  const rawStep = Number(snapshot?.step);
  if (Number.isFinite(rawStep)) return rawStep;
  return Math.max(0, index >= 0 ? index : app.snapshotIndex);
}

function usesUiChronicleSteps() {
  const source = app.datasetSource || {};
  return source.kind === "real" && Boolean(source.live || source.runtimeStartedAt || source.runtimeInstanceId);
}

function positionToCanvas(position, index) {
  const normalized = normalizePosition(position, index);
  return {
    x: normalized.x * app.width,
    y: normalized.y * app.height,
  };
}

function radiusForAgent(agent) {
  const ratio = clamp(agent.energy / Math.max(1, agent.maxEnergy), 0, 1.4);
  const dead = agent.lifecycle === "dead";
  if (dead) return 5.8;
  return clamp(4 + Math.sqrt(ratio) * 11, 4.5, 16);
}

function colorForAgent(agent) {
  if (agent.lifecycle === "dead") return "#89908c";
  if (agent.lifecycle === "exhausted" || agent.lifecycle === "dying") return "#c9821e";
  return GROUP_COLORS[agent.group] || GROUP_COLORS[groupForIndex(agent.order || 0)] || "#0e8a82";
}

function buildWorldState(agents, relations, society = {}, reward = {}, events = []) {
  const populationCount = agents.length;
  const aliveCount = agents.filter((agent) => agent.canAct ?? canAgentAct(agent.status, agent.lifecycle)).length;
  const deadCount = agents.filter((agent) => agent.lifecycle === "dead").length;
  const dyingCount = agents.filter((agent) => agent.lifecycle === "exhausted" || agent.lifecycle === "dying").length;
  const totalEnergy = agents.reduce((sum, agent) => sum + Number(agent.energy || 0), 0);
  const sourceStars = (reward.sources || []).reduce((sum, source) => sum + Number(source.last_checked_value || 0), 0);
  const mainProjects = topProjects(agents, reward.sources || []);
  return {
    aliveCount,
    populationCount,
    deadCount,
    dyingCount,
    totalEnergy,
    circulatingTokens: society.circulating_token_count ?? society.circulatingTokens ?? society.token_count ?? society.tokenCount ?? 0,
    tokenCount: society.token_count ?? society.tokenCount ?? 0,
    repoCount: reward.source_count ?? (reward.sources || []).length ?? 0,
    githubStars: reward.githubStars ?? reward.github_stars ?? sourceStars,
    recentStars: reward.recentStars ?? reward.recent_stars ?? 0,
    rewardReceiptCount: reward.available_receipt_count ?? reward.rewardReceiptCount ?? 0,
    recentDeathEvents: deathEvents(events),
    mainProjects,
    relationCount: relations.length,
  };
}

function topProjects(agents, sources) {
  const counts = new Map();
  for (const source of sources) {
    if (source.project_id) counts.set(source.project_id, (counts.get(source.project_id) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([project]) => project);
}

function symmetrizeRelations(relations) {
  const map = new Map();
  for (const item of relations) {
    let source = item.source || item.from || item.source_agent_id;
    let target = item.target || item.to || item.target_agent_id;
    if (!source && item.pair) {
      const parts = String(item.pair).split("->");
      source = parts[0];
      target = parts[1];
    }
    if (!source || !target || source === target) continue;
    const key = pairKey(source, target);
    const score = clamp(Number(item.visualAffinity ?? item.visual_affinity ?? item.score ?? item.weight ?? 0), 0, 1);
    const previous = map.get(key);
    if (!previous || score > previous.score) {
      const [left, right] = key.split("::");
      map.set(key, { source: left, target: right, score });
    }
  }
  return [...map.values()];
}

function buildDistanceRelations(nodes, relations) {
  if (!nodes.length) return relations;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visualScores = relationVisualScoreMap(relations);
  return relations
    .map((relation) => {
      const source = nodeById.get(relation.source);
      const target = nodeById.get(relation.target);
      if (!source || !target) return null;
      const visualDistance = distanceBetweenNodes(source, target);
      const score = clamp(Number(relation.score), 0, 1);
      const key = pairKey(relation.source, relation.target);
      return {
        ...relation,
        score,
        visualScore: visualScores.get(key) ?? 0,
        distance: visualDistance,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function relationVisualScoreMap(relations) {
  const items = relations
    .map((relation, index) => ({
      index,
      key: pairKey(relation.source, relation.target),
      score: clamp(Number(relation.score), 0, 1),
    }))
    .filter((item) => item.key && Number.isFinite(item.score));
  const visualScores = new Map();
  if (!items.length) return visualScores;
  if (items.length === 1) {
    visualScores.set(items[0].key, 1);
    return visualScores;
  }
  items.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key) || a.index - b.index);
  for (let index = 0; index < items.length; index += 1) {
    const percentile = index / (items.length - 1);
    visualScores.set(items[index].key, Math.pow(percentile, RELATION_VISUAL_GAMMA));
  }
  return visualScores;
}

function relationVisualScore(relation) {
  return clamp(Number(relation.visualScore ?? relation.score ?? 0), 0, 1);
}

function pairKey(left, right) {
  return [String(left), String(right)].sort().join("::");
}

function topRelations(agentId, limit) {
  return app.links
    .filter((relation) => relation.source === agentId || relation.target === agentId)
    .map((relation) => {
      const otherId = relation.source === agentId ? relation.target : relation.source;
      return {
        score: relation.score,
        agent: app.nodeById.get(otherId),
      };
    })
    .filter((relation) => relation.agent)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function distanceBetweenNodes(source, target) {
  const left = relationPointForNode(source);
  const right = relationPointForNode(target);
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function relationPointForNode(node) {
  const position = node?.position;
  if (position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
    return normalizePosition(position, node.order || 0);
  }
  if (Number.isFinite(Number(node?.x)) && Number.isFinite(Number(node?.y))) {
    return {
      x: clamp(Number(node.x), 0, 1),
      y: clamp(Number(node.y), 0, 1),
    };
  }
  return { x: 0.5, y: 0.5 };
}

function isAgentBusy(agent) {
  const status = String(agent.status || "").toLowerCase();
  const threadState = String(agent.thread?.state || "").toLowerCase();
  return status === "running" || threadState === "busy" || Boolean(agent.thread?.current_job_id);
}

function phaseName({ busyAgents, lowEnergyAgents, errorAgents, strongLinks, total }) {
  if (errorAgents.length >= Math.max(2, total * 0.18)) return "裂隙蔓延";
  if (lowEnergyAgents.length >= Math.max(1, total * 0.18)) return "火种吃紧";
  if (busyAgents.length >= Math.max(2, total * 0.55)) return "全镇开工";
  if (strongLinks.length >= total) return "盟约成形";
  return "初火探索";
}

function buildWatchQueue(snapshot, context) {
  const items = [];
  for (const agent of context.errorAgents.slice(0, 3)) {
    items.push({
      kind: "risk",
      agentId: agent.id,
      title: `${agent.name} 遭遇裂隙`,
      meta: "受阻",
      body:
        agent.thread?.last_error ||
        agent.currentTask ||
        agentSummaryPreview(agent, 170) ||
        "最近一轮行动没有顺利归来。",
    });
  }
  for (const agent of context.lowEnergyAgents.slice(0, 3)) {
    const percent = Math.round((agent.energy / Math.max(agent.maxEnergy, 1)) * 100);
    items.push({
      kind: "energy",
      agentId: agent.id,
      title: `${agent.name} 火种告急`,
      meta: `${percent}%`,
      body: loreTextForDisplay(agent.currentTask || agentSummaryPreview(agent, 170) || "生命火种正在接近危险线。"),
    });
  }
  for (const agent of context.busyAgents.slice(0, 4)) {
    items.push({
      kind: "work",
      agentId: agent.id,
      title: `${agent.name} 开工中`,
      meta: agent.thread?.current_job_id || "进行中",
      body: loreTextForDisplay(
        agent.currentTask ||
          agentSummaryPreview(agent, 170) ||
          workTextForDisplay(agent.goal, agent) ||
          "正在推进当前委托。",
      ),
    });
  }
  for (const relation of context.strongLinks.slice(0, 2)) {
    const source = snapshot.agents.find((agent) => agent.id === relation.source);
    const target = snapshot.agents.find((agent) => agent.id === relation.target);
    if (!source || !target) continue;
    items.push({
      kind: "bond",
      agentId: source.id,
      title: `${source.name} ↔ ${target.name}`,
      meta: `${Math.round(relation.score * 100)}%`,
      body: "新的纽带正在把两条行动线拉近。",
    });
  }
  return dedupeBy(items, (item) => `${item.kind}:${item.agentId}:${item.title}`).slice(0, 9);
}

function buildLiveFeed(snapshot, previous, queue, energyDelta) {
  const agents = snapshot.agents || [];
  const feed = [];
  const displayStep = displayChronicleStep(snapshot);
  if (previous) {
    const stepDelta = displayStep - displayChronicleStep(previous);
    if (stepDelta > 0) {
      feed.push({
        title: "新章节",
        meta: `+${formatNumber(stepDelta)}`,
        body: `编年史已保留 ${formatNumber(app.snapshots.length)} 个章节。`,
      });
    }
    if (energyDelta !== 0) {
      feed.push({
        title: "火种变化",
        meta: energyDelta > 0 ? `+${formatNumber(energyDelta)}` : formatNumber(energyDelta),
        body: energyDelta < 0 ? "营地总火种继续消耗。" : "营地总火种出现补充。",
      });
    }
  }
  for (const event of (snapshot.keyEvents || []).slice(0, 5)) {
    const rawText = String(event);
    const text = eventTextForDisplay(rawText);
    const agent = findAgentInText(rawText, agents);
    feed.push({
      title: agent ? agent.name : eventTitle(text),
      meta: `第 ${formatNumber(displayStep)} 刻`,
      body: text,
      agentId: agent?.id,
    });
  }
  for (const item of queue.slice(0, 3)) {
    feed.push({
      title: item.title,
      meta: item.meta,
      body: item.body,
      agentId: item.agentId,
    });
  }
  return dedupeBy(feed, (item) => `${item.title}:${item.body}`).slice(0, 10);
}

function chooseSpotlightAgent(snapshot, queue, busyAgents, lowEnergyAgents, errorAgents) {
  const queuedAgent = queue.find((item) => item.agentId)?.agentId;
  if (queuedAgent) return snapshot.agents.find((agent) => agent.id === queuedAgent) || null;
  return errorAgents[0] || lowEnergyAgents[0] || busyAgents[0] || mostActiveAgent(snapshot.agents);
}

function mostActiveAgent(agents) {
  return [...agents].sort((a, b) => {
    const left = Number(a.activity || 0) + Number(a.recentTurn || 0) / 1000;
    const right = Number(b.activity || 0) + Number(b.recentTurn || 0) / 1000;
    return right - left;
  })[0] || null;
}

function findAgentInText(text, agents) {
  return agents.find((agent) => text.includes(agent.id) || text.includes(agent.name));
}

function eventTitle(text) {
  return String(text).split(/[：:。]/)[0].slice(0, 16) || "事件";
}

function agentStatusLabel(agent) {
  if (isAgentBusy(agent)) return "开工中";
  if (agent.lifecycle === "exhausted") return "火种低";
  if (String(agent.status || "").toLowerCase() === "error") return "裂隙";
  return lifecycleLabel(agent.lifecycle);
}

function agentSpotlightText(agent) {
  return loreTextForDisplay(
    agent.currentTask || agentSummaryPreview(agent, 180) || workTextForDisplay(agent.goal, agent) || "暂无传闻",
  );
}

function agentSummaryPreview(agent, limit = 180) {
  const text = summarizeAgentText(agent.recentSummary || agent.last_summary || "", agent);
  return text ? shortText(loreTextForDisplay(text), limit) : "";
}

function summarizeAgentText(text, agent = null) {
  const value = String(text || "").trim();
  if (!value) return "";
  const personalStatus = extractPersonalStatus(value);
  if (personalStatus) return personalStatus;
  const initial = parseInitialMemory(value);
  if (initial) {
    if (agent?.lifeMemory) return agent.lifeMemory;
    return initial.life || initial.work || "";
  }
  return softenAgentSummary(cleanupRichText(value));
}

function extractPersonalStatus(text) {
  const match = String(text || "").match(/【近况】\s*([^\n]+)/);
  return match?.[1]?.trim() || "";
}

function softenAgentSummary(text) {
  let value = String(text || "").trim();
  if (!value) return "";
  value = value
    .replace(/我对(?:整个|当前)?(?:情况|局面|上下文)有了(?:比较)?(?:完整|全面|清晰)的(?:把握|认识|理解)[，,。]*/g, "我刚把眼前的情况理了一遍，")
    .replace(/积累了(?:一些|较多|足够的)?(?:结构化)?(?:数据|信息|资料|上下文)[，,。]*/g, "手里也多了一些线索，")
    .replace(/形成了(?:初步|稳定)?(?:判断|认知|框架)[，,。]*/g, "大概知道下一步该看哪里，")
    .replace(/完成了(?:对)?(.{0,18}?)(?:的)?(?:梳理|整理|分析)[，,。]*/g, "我刚整理了$1，")
    .replace(/推进了(.{0,18}?)(?:的)?(?:工作|任务|事项)[，,。]*/g, "我刚推进了$1，")
    .replace(/\bproject_alpha\b/g, "主线项目")
    .replace(/\bruntime_infra\b/g, "小镇运行底座")
    .replace(/\bmemory_archive\b/g, "记忆档案")
    .replace(/\benergy_rescue\b/g, "火种救援")
    .replace(/\breward receipt\b/gi, "奖励凭证")
    .replace(/\bREADME\b/g, "说明文档");
  return value;
}

function parseInitialMemory(text) {
  const match = String(text).match(/^Initial memory:\s*life=(.*?);\s*work=(.*)$/s);
  if (!match) return null;
  return {
    life: match[1].trim(),
    work: match[2].trim(),
  };
}

function cleanupRichText(text) {
  return String(text)
    .replace(/^---+/gm, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function buildDemoDataset() {
  const groups = [
    { id: "alpha", name: "开源实现组", project: "project_alpha", center: [0.34, 0.36] },
    { id: "verifier", name: "验证复现组", project: "project_alpha", center: [0.6, 0.34] },
    { id: "infra", name: "基础设施组", project: "runtime_infra", center: [0.43, 0.62] },
    { id: "rescue", name: "火种救援组", project: "energy_rescue", center: [0.72, 0.58] },
    { id: "archive", name: "知识档案组", project: "memory_archive", center: [0.23, 0.64] },
    { id: "bridge", name: "关系桥接组", project: "coordination_bridge", center: [0.52, 0.48] },
    { id: "orbit", name: "外围观察组", project: "field_observation", center: [0.79, 0.28] },
  ];
  const agents = Array.from({ length: 100 }, (_, index) => {
    const group = groups[index % groups.length];
    const number = String(index + 1).padStart(3, "0");
    return {
      id: `agent-${number}`,
      name: `${group.name.split("").slice(0, 2).join("")}-${number}`,
      role: demoRole(index, group),
      group: group.id,
      groupName: group.name,
      project: group.project,
      baseEnergy: 42 + ((index * 37) % 58),
      maxEnergy: 100,
      seed: index * 9973 + 17,
    };
  });

  const snapshots = Array.from({ length: 7 }, (_, snapIndex) => {
    const step = snapIndex * 300;
    const snapshotAgents = agents.map((agent, index) => demoAgentAtStep(agent, index, snapIndex, groups));
    const relations = buildDemoRelations(agents, snapIndex);
    const worldState = buildWorldState(snapshotAgents, relations, {
      token_count: 36 + snapIndex * 11,
    }, {
      source_count: 3,
      githubStars: 48 + snapIndex * 9 + (snapIndex > 3 ? 18 : 0),
      recentStars: snapIndex === 0 ? 0 : 7 + (snapIndex % 3) * 4,
      available_receipt_count: Math.max(0, 5 - snapIndex) + (snapIndex > 4 ? 3 : 0),
      sources: [
        { project_id: "project_alpha", last_checked_value: 38 + snapIndex * 8 },
        { project_id: "runtime_infra", last_checked_value: 8 + snapIndex * 2 },
        { project_id: "memory_archive", last_checked_value: 2 + snapIndex },
      ],
    }, []);
    worldState.mainProjects = ["project_alpha", "runtime_infra", "energy_rescue", "memory_archive"];
    worldState.recentDeathEvents = demoDeathEvents(snapIndex);
    return {
      step,
      createdAt: new Date(Date.now() - (6 - snapIndex) * 300_000).toISOString(),
      agents: snapshotAgents,
      relations,
      worldState,
      keyEvents: demoEvents(snapIndex),
      mainline: demoMainline(snapIndex),
      worldSummary: {
        step,
        createdAt: new Date(Date.now() - (6 - snapIndex) * 300_000).toISOString(),
        previousWorldSummaryIds: snapIndex
          ? Array.from({ length: Math.min(5, snapIndex) }, (_, i) => `world-${snapIndex - i - 1}`)
          : [],
        inputAgentSummaryRange: { per_agent_limit: 5, agent_count: 100 },
        summaryText: demoWorldSummary(snapIndex, worldState),
      },
    };
  });

  return { snapshots };
}

function demoAgentAtStep(agent, index, snapIndex, groups) {
  const rng = mulberry32(agent.seed + snapIndex * 101);
  const group = groups.find((item) => item.id === agent.group);
  const critical = [12, 27, 43, 68, 91].includes(index);
  const collapse = (index === 27 && snapIndex >= 4) || (index === 68 && snapIndex >= 5);
  const recovery = index === 12 && snapIndex >= 5;
  let energy = agent.baseEnergy - snapIndex * (4 + (index % 5)) + Math.round(rng() * 10);
  if (agent.group === "rescue" && snapIndex >= 3) energy += 14;
  if (agent.group === "alpha" && snapIndex >= 4) energy += 10;
  if (critical) energy -= snapIndex * 5;
  if (recovery) energy += 32;
  if (collapse) energy = 0;
  energy = Math.max(0, Math.min(120, energy));
  const lifecycle = energy <= 0 ? "dead" : energy < 14 ? "exhausted" : "alive";
  const angle = (index * 2.399963 + snapIndex * 0.09) % (Math.PI * 2);
  const ring = 0.035 + (index % 5) * 0.018 + rng() * 0.012;
  const driftX = Math.sin(snapIndex * 0.4 + index) * 0.018;
  const driftY = Math.cos(snapIndex * 0.37 + index * 0.3) * 0.016;
  let x = group.center[0] + Math.cos(angle) * ring + driftX;
  let y = group.center[1] + Math.sin(angle) * ring + driftY;
  if (agent.group === "alpha" && snapIndex >= 3) {
    x += 0.08;
    y += 0.02;
  }
  if (agent.group === "verifier" && snapIndex >= 3) {
    x -= 0.07;
  }
  if (lifecycle === "dead") {
    x = 0.12 + (index % 6) * 0.055;
    y = 0.9 - (index % 4) * 0.025;
  }

  const projects = agent.group === "bridge"
    ? [agent.project, "project_alpha"]
    : agent.group === "rescue"
      ? [agent.project, "project_alpha"]
      : [agent.project];

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    group: agent.group,
    status: lifecycle === "alive" ? "working" : lifecycle,
    lifecycle,
    energy,
    maxEnergy: agent.maxEnergy,
    activity: lifecycle === "dead" ? 0 : clamp(0.35 + rng() * 0.65 - snapIndex * 0.02, 0.12, 1),
    recentSummary: demoRecentSummary(agent, snapIndex, lifecycle),
    incrementalSummaries: demoIncrementalSummaries(agent, snapIndex, lifecycle),
    lifeMemory: `曾经在${agent.groupName}中形成稳定偏好：${demoMemoryTrait(agent.group)}。`,
    workMemory: `当前把 ${projects.join("、")} 的进展、验证证据和火种消耗绑定在同一条工作记忆里。`,
    skills: demoSkills(agent.group),
    currentTask: demoTask(agent, snapIndex, lifecycle),
    projects,
    recentToolCalls: demoToolCalls(agent, snapIndex, lifecycle),
    recentTurn: snapIndex * 4 + (index % 4),
    localTurn: snapIndex * 2 + (index % 7),
    modelCallCount: snapIndex * 4 + (index % 4),
    position: { x: clamp(x, 0.04, 0.96), y: clamp(y, 0.06, 0.94) },
  };
}

function buildDemoRelations(agents, snapIndex) {
  const relations = [];
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      const a = agents[i];
      const b = agents[j];
      const rng = mulberry32(i * 7919 + j * 104729 + snapIndex * 41);
      let score = 0.04 + rng() * 0.13;
      if (a.group === b.group) score += 0.46 + rng() * 0.24;
      if (a.project === b.project) score += 0.13;
      if ((a.group === "alpha" && b.group === "verifier") || (a.group === "verifier" && b.group === "alpha")) {
        score += snapIndex >= 3 ? 0.31 : 0.18;
      }
      if (a.group === "bridge" || b.group === "bridge") {
        score += 0.16 + (snapIndex >= 2 ? 0.08 : 0);
      }
      if ((a.group === "rescue" || b.group === "rescue") && snapIndex >= 4) {
        score += 0.12;
      }
      if ((i + j + snapIndex) % 29 === 0) score += 0.18;
      relations.push({
        source: a.id,
        target: b.id,
        score: clamp(score, 0.02, 0.98),
      });
    }
  }
  return relations;
}

function demoMainline(snapIndex) {
  const lines = [
    "第一批居民抵达小镇，project_alpha 像刚点燃的篝火一样吸引了实现组和验证组，档案组开始记录最早的共识。",
    "project_alpha 成为第一条主线，实现组打造工具，验证组守住证据，桥接组把分散的低语转成可执行的委托。",
    "基础设施组加入后，小镇从单点开工转向运行时、记忆和奖励路径的并行探索，火种吃紧的居民开始寻找贡献入口。",
    "外部声望让 project_alpha 的火光更亮，但 README 复现流程仍被验证组反复拦下，不能贸然宣布胜利。",
    "火种救援组开始接管低火种居民，小镇把推进项目和重新分配资源放到同一条主线上。",
    "两位低火种居民陨落后，协作结构收紧；桥接组把救援、验证和档案拉近，避免核心篝火变成混乱人群。",
    "最新章节正在稳定复现链路并消化新增声望，核心居民继续靠近，外围观察者正在决定是否加入主线。",
  ];
  return lines[snapIndex] || lines.at(-1);
}

function demoWorldSummary(snapIndex, state) {
  const deathLine = state.deadCount
    ? `小镇里已经有 ${state.deadCount} 位居民陨落，${state.dyingCount} 位居民的火种接近熄灭。救援组因此从旁支任务变成了主线的一部分。`
    : `小镇暂时无人陨落，但已有 ${state.dyingCount} 位居民接近火种低位，资源分配的压力开始显形。`;
  return `【城镇记录】
当前第 ${state.step ?? snapIndex * 300} 刻附近，小镇的注意力主要围绕 project_alpha、runtime_infra 和 energy_rescue 展开。project_alpha 仍是最亮的篝火：实现组持续推进开源工具，验证组反复要求 README、复现脚本和边界条件保持一致，档案组则把阶段性结论压缩成后续居民能继承的记录。${deathLine}

【居民与阵营】
开源实现组负责把想法锻造成可运行产物，它们火种消耗较快，但也最容易获得外部奖励。验证复现组像守门人，会把不稳定的结论拉回证据层。基础设施组维护运行时和数据结构，让注意力关系、火种账本和奖励凭证进入同一个事实视图。火种救援组在后半段变得重要，因为低火种居民开始主动靠近项目核心，希望用可验证贡献换取下一轮补给。桥接组负责把这些阵营连接起来，避免强关系居民挤成一个不可读的点团。

【关键变化】
相比上一阶段，地图上最明显的变化是 project_alpha 周围形成了更紧的花环结构：实现组与验证组靠近，但没有完全重叠，因为验证组仍保持距离来维持独立判断。外围观察组仍在边缘游走，它们和核心项目的纽带分数上升，却还没有完全并入主阵营。档案组的位置更稳定，说明它们承担的是城镇记忆而不是短期冲刺。火种状态正在改变协作结构：高火种居民继续在核心区域活动，低火种居民则向救援组和奖励路径移动。

【悬念】
如果下一轮声望继续增加，小镇会把奖励优先分给核心实现者，还是转向拯救那些已经接近陨落的外围居民？`;
}

function demoRecentSummary(agent, snapIndex, lifecycle) {
  if (lifecycle === "dead") {
    return `${agent.name} 的火种已经耗尽，最近记录停留在未完成的 ${agent.project} 交接。`;
  }
  const summaries = {
    alpha: "把核心实现推进到可演示状态，但等待验证组确认复现路径。",
    verifier: "重新检查 README 与测试脚本的一致性，拒绝提前宣布完成。",
    infra: "整理运行时状态接口，让火种、关系和项目进展能被前端读取。",
    rescue: "识别低火种居民，尝试把他们连接到可获得奖励的任务。",
    archive: "压缩最近的居民增量记录，维护跨阶段的城镇记忆。",
    bridge: "把实现组、验证组和救援组的分歧转写成可行动消息。",
    orbit: "观察 project_alpha 的奖励信号，评估是否加入核心协作。",
  };
  return `第 ${snapIndex * 300} 刻: ${summaries[agent.group]}`;
}

function demoIncrementalSummaries(agent, snapIndex, lifecycle) {
  return Array.from({ length: Math.min(5, snapIndex + 1) }, (_, index) => {
    const step = (snapIndex - index) * 300;
    if (lifecycle === "dead" && index === 0) {
      return `第 ${step} 刻: 火种归零，留下委托交接记录。`;
    }
    return `第 ${step} 刻: ${demoRecentSummary(agent, Math.max(0, snapIndex - index), "alive")}`;
  }).reverse();
}

function demoTask(agent, snapIndex, lifecycle) {
  if (lifecycle === "dead") return "停止活动，等待历史回放或救援事件标记。";
  const tasks = {
    alpha: "收敛 project_alpha 的可运行实现与发布脚本。",
    verifier: "复核 README 复现流程和边界条件声明。",
    infra: "维护城镇状态快照、关系分数和火种账本接口。",
    rescue: "寻找低火种居民可接入的低风险贡献点。",
    archive: "把最近 300 刻的增量记录整理成城镇记录输入。",
    bridge: "把跨团体冲突转成明确的下一步协作请求。",
    orbit: "观察核心项目的奖励密度和进入成本。",
  };
  return `${tasks[agent.group]} 第 ${snapIndex + 1} 轮。`;
}

function demoMemoryTrait(group) {
  return {
    alpha: "偏好先做能被验证的最小实现",
    verifier: "偏好保留反例、证据和复现路径",
    infra: "偏好把隐含状态变成结构化事实",
    rescue: "偏好在火种危机前寻找转移路径",
    archive: "偏好长期记忆和摘要连续性",
    bridge: "偏好把团体语言翻译成共同任务",
    orbit: "偏好低承诺观察和机会窗口判断",
  }[group];
}

function demoSkills(group) {
  return {
    alpha: ["TypeScript", "Rust glue", "release script", "README patch"],
    verifier: ["reproduction", "test evidence", "boundary analysis", "risk note"],
    infra: ["state adapter", "snapshot schema", "energy ledger", "attention pairs"],
    rescue: ["energy triage", "task voucher", "reward receipt", "agent routing"],
    archive: ["incremental summary", "world summary input", "memory pruning", "timeline notes"],
    bridge: ["coordination", "conflict framing", "message routing", "project handoff"],
    orbit: ["trend watch", "weak signal", "entry timing", "external feedback"],
  }[group] || ["observation"];
}

function demoToolCalls(agent, snapIndex, lifecycle) {
  if (lifecycle === "dead") {
    return [
      {
        kind: "idle",
        title: "进入空闲",
        body: "火种归零后没有新的行动记录，其他居民只能感知到他的沉默状态。",
        status: "idle",
        sourceLabel: "社会现场",
      },
    ];
  }
  const pool = {
    alpha: [
      ["read", "查阅接口登记表", "他翻看项目入口，确认下一步该改哪处资料。", "本地工作空间"],
      ["write", "修改实现文件", "他把新的判断写进工作空间，等待验证结果回传。", "本地工作空间"],
      ["verify", "校验工坊状态", "他让系统跑过一次检查，确认这轮改动能否站稳。", "本地工作空间"],
    ],
    verifier: [
      ["verify", "复核复现路径", "他沿着 README 的步骤重新检查一次边界条件。", "本地工作空间"],
      ["search", "追踪失败线索", "他在事件痕迹里寻找不稳定行为出现的位置。", "公共频道"],
      ["write", "记录验证结论", "他把风险和证据写成可被后来者读取的判断。", "本地工作空间"],
    ],
    infra: [
      ["social", "查看居民行踪", "他确认其他居民是否仍在行动，避免把待命误判成消失。", "公共频道"],
      ["search", "追踪关系拓扑", "他查看关系网络的靠近和远离，调整感知重点。", "公共频道"],
      ["write", "更新现场记录", "他把运行时状态整理成前端可以读取的现场记录。", "本地工作空间"],
    ],
    rescue: [
      ["ledger", "结算火种流转", "他记录一次资源转移，让低火种居民有机会继续行动。", "火种系统"],
      ["ledger", "查看奖励线索", "他寻找外部奖励信号，判断哪里能补充城镇火种。", "火种系统"],
      ["message", "查看收件箱", "他检查是否有人发来求助、回复或协作请求。", "公共频道"],
    ],
    archive: [
      ["write", "整理增量摘要", "他把零散行动压缩成后续能继续引用的记忆。", "本地工作空间"],
      ["search", "追踪城镇事件", "他沿着事件列表确认最近世界线发生了什么。", "公共频道"],
      ["message", "查看收件箱", "他检查是否有人发来求助、回复或协作请求。", "公共频道"],
    ],
    bridge: [
      ["message", "发送协作讯号", "他把一个人的需求转交给另一个可能响应的人。", "公共频道"],
      ["message", "转交居民回复", "他把回音送回原来的关系链，让对话继续流动。", "公共频道"],
      ["search", "追踪关系拓扑", "他观察强关系和弱关系的变化，决定该把消息送给谁。", "公共频道"],
    ],
    orbit: [
      ["search", "观察城镇事件", "他扫过近期事件，寻找值得靠近的机会窗口。", "公共频道"],
      ["ledger", "查看奖励线索", "他检查哪些外部信号可能改变资源分布。", "火种系统"],
      ["search", "追踪关系拓扑", "他观察强关系和弱关系的变化，决定是否接近核心。", "公共频道"],
    ],
  }[agent.group];
  return pool.map(([kind, title, body, sourceLabel], index) => ({
    kind,
    title,
    body,
    sourceLabel,
    name: title,
    status: index === 0 && snapIndex % 3 === 0 ? "running" : "ok",
    summary: body,
  }));
}

function demoRole(index, group) {
  const roles = ["builder", "verifier", "scribe", "router", "observer", "rescuer", "maintainer"];
  return `${group.name} · ${roles[index % roles.length]}`;
}

function demoEvents(snapIndex) {
  const events = [
    ["100 位居民抵达定居点地图", "project_alpha 被注册为第一条主线"],
    ["实现组与验证组形成第一条强纽带", "档案组生成首批跨居民记录"],
    ["runtime_infra 加入主线", "桥接组开始连接外围观察者"],
    ["GitHub stars 增量触发 reward receipt", "验证组阻止不稳定发布"],
    ["火种救援组靠近核心项目", "多位居民进入低火种区间"],
    ["agent-028 陨落事件进入编年史", "救援路径开始影响项目优先级"],
    ["project_alpha 周围形成稳定花环", "外围观察组关系分数继续上升"],
  ];
  return events[snapIndex] || events.at(-1);
}

function demoDeathEvents(snapIndex) {
  if (snapIndex < 4) return [];
  if (snapIndex === 4) return ["agent-028 濒死"];
  if (snapIndex === 5) return ["agent-028 死亡", "agent-069 濒死"];
  return ["agent-028 陨落", "agent-069 陨落"];
}

function runtimeSummaryText(agents, state, collaboration) {
  const active = agents.filter((agent) => agent.lifecycle !== "dead").length;
  const projects = state.mainProjects.length ? state.mainProjects.join("、") : "尚未形成稳定项目";
  const events = eventTexts(collaboration.collab_events || collaboration.events || []).slice(0, 4).join("；");
  return `【城镇记录】
当前小镇有 ${active} 位活跃居民，主要任务线为 ${projects}。营地火种总量为 ${formatNumber(state.totalEnergy)}，低火种居民数量为 ${formatNumber(state.dyingCount)}。

【居民与阵营】
从现有运行记录看，居民角色、委托和注意力纽带已经开始稳定。地图会把强纽带居民拉近，让玩家能看见阵营和合作关系的形成。

【关键变化】
最近事件：${events || "暂无事件"}。

【悬念】
下一次城镇记录会出现新的核心阵营，还是现有任务线继续吸收外围居民？`;
}

function mainlineFromSummary(text) {
  const cleaned = text.replace(/【[^】]+】/g, "").trim();
  const sentence = cleaned.split(/[。！？\n]/).find((item) => item.trim().length > 16);
  return sentence ? `${sentence.trim()}。` : "小镇正在形成新的阵营和协作纽带。";
}

function normalizeLifecycle(value, energy = 0, maxEnergy = 100) {
  const text = String(value || "").toLowerCase();
  if (["dead", "死亡"].includes(text)) return "dead";
  if (["exhausted", "dying", "濒死"].includes(text)) return "exhausted";
  if (["rescued", "救援"].includes(text)) return "rescued";
  if (text === "error" || text.includes("failed")) return "exhausted";
  if (energy <= 0) return "dead";
  if (energy <= Math.max(10, maxEnergy * 0.14)) return "exhausted";
  return "alive";
}

function canAgentAct(status, lifecycle) {
  const value = String(status || "").toLowerCase();
  return !["dead", "exhausted", "dying"].includes(lifecycle) && value !== "error" && !value.includes("failed");
}

function statusToLifecycle(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("dead")) return "dead";
  if (value.includes("exhaust")) return "exhausted";
  return "alive";
}

function lifecycleLabel(lifecycle) {
  return {
    alive: "在营",
    rescued: "已救援",
    exhausted: "火种低",
    dying: "火种低",
    dead: "陨落",
  }[lifecycle] || lifecycle;
}

function threadStateLabel(value) {
  const text = String(value || "").toLowerCase();
  if (["busy", "running", "active", "working", "in_progress"].includes(text)) return "开工中";
  if (["idle", "waiting", "pending"].includes(text)) return "待命";
  if (["error", "failed", "fail", "denied"].includes(text)) return "裂隙";
  if (["done", "completed", "ok", "success", "succeeded"].includes(text)) return "已归来";
  if (["dead", "death"].includes(text)) return "陨落";
  if (["exhausted", "dying"].includes(text)) return "火种低";
  return value || "未知";
}

function normalizeProjects(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function modelCallCounter(agent) {
  const direct = Number(
    agent?.modelCallCount ??
      agent?.model_call_count ??
      agent?.model_calls ??
      agent?.modelCalls ??
      agent?.llmCallCount ??
      agent?.llm_call_count,
  );
  if (Number.isFinite(direct)) return direct;
  return Number(agent?.recentTurn ?? agent?.recent_turn ?? agent?.history_len ?? agent?.localTurn ?? agent?.local_turn ?? 0) || 0;
}

function normalizePosition(position, index) {
  if (position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
    const x = Number(position.x);
    const y = Number(position.y);
    return {
      x: x > 1 ? clamp(x / Math.max(app.width, 1), 0.02, 0.98) : clamp(x, 0.02, 0.98),
      y: y > 1 ? clamp(y / Math.max(app.height, 1), 0.02, 0.98) : clamp(y, 0.02, 0.98),
    };
  }
  return positionForIndex(index, 100);
}

function boundsFromPositions(positions) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const pos of positions) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x);
    maxY = Math.max(maxY, pos.y);
  }
  const width = Math.max(maxX - minX, 0.01);
  const height = Math.max(maxY - minY, 0.01);
  return { minX, minY, maxX, maxY, width, height };
}

function layoutSpread() {
  const relationDensity = Math.min(1, Math.max(0.78, app.links.length / Math.max(app.nodes.length * 10, 1)));
  return {
    x: Math.max(140, (app.width - 32) * 0.47 * relationDensity),
    y: Math.max(140, (app.height - 32) * 0.43 * relationDensity),
  };
}

function layoutLinkDistance(score, source, target) {
  const base = 34 + (1 - score) * 170;
  const related = source.group === target.group ? -12 : 0;
  const projectRelated = compact(source.projects).some((project) => compact(target.projects).includes(project)) ? -10 : 0;
  return clamp(base + related + projectRelated, 24, 190);
}

function positionForIndex(index, count) {
  const angle = (index / count) * Math.PI * 2;
  const radius = 0.34 + ((index % 7) - 3) * 0.018;
  return {
    x: clamp(0.5 + Math.cos(angle) * radius, 0.05, 0.95),
    y: clamp(0.5 + Math.sin(angle) * radius, 0.07, 0.93),
  };
}

function groupForIndex(index) {
  return ["alpha", "verifier", "infra", "rescue", "archive", "bridge", "orbit"][index % 7];
}

function activeTaskForAgent(agent, jobs, thread = null) {
  const job = jobs.find((item) => item.agent_id === agent.id && item.status !== "done");
  return workTextForDisplay(job?.prompt || job?.last_summary || thread?.current_prompt_preview || agent.goal || "", agent);
}

function projectsForAgent(agent, sources) {
  const fromGoal = (agent.goal || "").match(/project[_-][a-z0-9_-]+/i)?.[0];
  const sourceProject = sources.find((source) => source.project_id && agent.goal?.includes(source.project_id))?.project_id;
  return compact([fromGoal, sourceProject]);
}

function memoryField(agent, kind) {
  const memory = agent.long_term_memory || agent.longTermMemory || {};
  if (kind === "life") {
    return agent.lifeMemory || agent.life_memory || memory.life_memory || memory.lifeMemory || agent.origin_story || "";
  }
  return agent.workMemory || agent.work_memory || memory.work_memory || memory.workMemory || "";
}

function normalizeActionEvents(values) {
  return (values || []).map(actionEventFromRecord).filter(Boolean);
}

function normalizeToolCalls(values) {
  return normalizeActionEvents(values);
}

function actionEventFromRecord(item) {
  const record = item && typeof item === "object" ? item : { summary: String(item || "") };
  const rawName =
    record.sourceName ||
    record.source_name ||
    record.toolName ||
    record.tool_name ||
    record.name ||
    record.tool ||
    "";
  const parsedInput = parseJsonLoose(record.input);
  const parsedOutput = parseJsonLoose(record.output);
  const rawSummary = record.body || record.summary || record.output || record.input || "";
  const inferred = inferActionEvent(rawName, parsedInput || {}, parsedOutput || {}, rawSummary, record.input, record.output);
  const status = normalizeActionStatus(
    record.status || inferred.status || detectActionStatus(record.output || rawSummary, parsedOutput),
  );
  const kind = actionKindClass(record.kind || inferred.kind || (status === "error" ? "error" : kindFromText(`${rawName} ${rawSummary}`)));
  const title = cleanActionTitle(record.title || inferred.title || actionTitleFromName(rawName, parsedInput, kind), kind);
  const cleanedBody = cleanActionBody(record.body || inferred.body || rawSummary);
  const body = cleanedBody && cleanedBody !== title ? cleanedBody : actionDefaultBody(kind);
  return {
    kind,
    status,
    statusLabel: actionStatusLabel(status),
    title: shortText(title, 56),
    body: shortText(body, 210),
    sourceLabel: record.sourceLabel || record.source_label || actionSourceLabel(rawName, parsedInput, kind),
    sourceName: rawName,
    raw: actionRawText(record, rawName),
  };
}

function inferActionEvent(name, input, output, summary, rawInput = "", rawOutput = "") {
  const normalizedName = String(name || "").toLowerCase();
  const payload = input?.payload && typeof input.payload === "object" ? input.payload : input || {};
  const action = String(payload.action || payload.primitive || payload.type || "").toLowerCase();

  if (normalizedName === "primitive_call") {
    if (payload.command) return describeShellCommand(payload.command);
    if (payload.patch) return describePatch(payload.patch);
    if (action === "shell") return describeShellCommand(rawInput || summary);
    if (action === "apply_patch") return describePatch(rawInput || summary);
    if (action.includes("read")) {
      return {
        kind: "read",
        title: "查阅工作资料",
        body: "他翻看了工作空间里的资料，用来校准下一步行动。",
      };
    }
    if (action.includes("write") || action.includes("patch")) {
      return {
        kind: "write",
        title: "写入工作资料",
        body: "他把新的判断写回工作空间，留给之后的行动继续引用。",
      };
    }
    return describeShellCommand(rawInput || summary);
  }

  if (normalizedName === "platform_call" || input?.package || normalizedName.includes(".")) {
    return describePlatformCall(input, name);
  }
  if (normalizedName === "apply_patch") return describePatch(rawInput || summary);
  if (normalizedName === "shell" || looksLikeShellAction(normalizedName)) return describeShellCommand(summary || rawInput || name);
  return describeNamedAction(name, summary, rawInput, rawOutput || extractOutputText(output));
}

function describeNamedAction(name, summary = "", rawInput = "", rawOutput = "") {
  const text = `${name || ""} ${summary || ""} ${rawInput || ""} ${rawOutput || ""}`.toLowerCase();
  if (text.includes("wait_agent") || text.includes(" wait")) {
    return {
      kind: "wait",
      title: "等待居民回应",
      body: "他暂停当前动作，等待别人的消息进入收件箱。",
    };
  }
  if (text.includes("call_agent") || text.includes("send_input") || text.includes("route_reply")) {
    return {
      kind: "message",
      title: "发送协作讯号",
      body: "他向另一位居民递出消息，让协作关系继续推进。",
    };
  }
  if (text.includes("bank") || text.includes("reward_oracle") || text.includes("energy")) {
    return {
      kind: "ledger",
      title: "查看火种账本",
      body: "他检查资源与火种流向，判断自己或他人的行动余量。",
    };
  }
  if (looksLikeShellAction(text)) return describeShellCommand(summary || rawInput || name);
  const kind = kindFromText(text);
  return {
    kind,
    title: actionTitleFromName(name, null, kind),
    body: actionDefaultBody(kind),
  };
}

function describePlatformCall(input = {}, fallbackName = "") {
  const nameParts = String(fallbackName || "").split(".");
  const pkg = String(input.package || nameParts[0] || "").toLowerCase();
  const action = String(input.action || nameParts[1] || "").toLowerCase();
  if (pkg === "bank") {
    if (action === "summary") {
      return {
        kind: "ledger",
        title: "查看火种账本",
        body: "他翻到账本页，确认当前小镇的资源和火种分布。",
      };
    }
    return {
      kind: "ledger",
      title: "结算火种流转",
      body: "他记录了一次资源结算，让火种变化进入公共账本。",
    };
  }
  if (pkg === "reward_oracle") {
    return {
      kind: "ledger",
      title: "查看奖励线索",
      body: "他检查外部奖励信号，寻找能补充城镇火种的机会。",
    };
  }
  if (pkg === "collaboration") {
    if (["call_agent", "call", "send_input", "route_reply"].includes(action)) {
      return {
        kind: "message",
        title: "发送协作讯号",
        body: "他向另一位居民递出消息，试图重新拉起一段协作。",
      };
    }
    if (["wait_agent", "wait"].includes(action)) {
      return {
        kind: "wait",
        title: "等待居民回应",
        body: "他停在原地等待回音，暂时没有推进新的行动。",
      };
    }
    if (["read_agent_status", "read_remote_agents", "health_remote_agent"].includes(action)) {
      return {
        kind: "social",
        title: "查看居民行踪",
        body: "他确认其他居民是否仍在行动，避免把待命误判成消失。",
      };
    }
    if (["read_inbox"].includes(action)) {
      return {
        kind: "message",
        title: "查看收件箱",
        body: "他查看有没有新的消息、请求或等待回复。",
      };
    }
    if (["read_jobs", "read_events", "read_trace", "read_topology"].includes(action)) {
      return {
        kind: "search",
        title: "追踪社会事件",
        body: "他沿着任务、事件或关系拓扑查找最近发生的变化。",
      };
    }
    if (["spawn_agent", "register_remote_agent"].includes(action)) {
      return {
        kind: "social",
        title: "召集新居民",
        body: "他把新的行动者接入社会，让协作网络出现新的节点。",
      };
    }
  }
  return {
    kind: "system",
    title: action ? `触发 ${action.replace(/_/g, " ")}` : "接触公共频道",
    body: "他通过公共频道留下了一条可追踪的行动记录。",
  };
}

function describeShellCommand(command) {
  const text = String(command || "").trim();
  const lower = text.toLowerCase();
  const target = likelyFileFromCommand(text);
  if (!text) {
    return {
      kind: "system",
      title: "记录本地动作",
      body: "系统记录了一次本地动作，但没有返回可读命令。",
    };
  }
  if (/\b(rg|grep)\b/.test(lower)) {
    return {
      kind: "search",
      title: `检索 ${target || "工作资料"}`,
      body: "他在资料堆里寻找线索，用结果决定下一步该看哪里。",
    };
  }
  if (/\b(cat|nl|head|tail|less)\b/.test(lower) || /\bsed\b/.test(lower) && /\s-n\b/.test(lower)) {
    return {
      kind: "read",
      title: `查阅 ${target || "工作资料"}`,
      body: "他翻看了工作空间里的资料，把关键事实带回当前判断。",
    };
  }
  if (/\b(cargo|npm|pnpm|yarn|bun|node|pytest|go)\b/.test(lower) && /\b(check|test|lint|build|tsc)\b/.test(lower)) {
    return {
      kind: "verify",
      title: "校验工坊状态",
      body: "他让系统跑过一次检查，用结果确认这一步是否站得住。",
    };
  }
  if (/\bcurl\b/.test(lower)) {
    return {
      kind: "read",
      title: "读取现场状态",
      body: "他向本地接口取回状态，确认小镇现场的最新变化。",
    };
  }
  if (/\b(ls|find|pwd|wc)\b/.test(lower)) {
    return {
      kind: "search",
      title: `巡视 ${target || "工作空间"}`,
      body: "他查看工作空间的地形，确认资料和入口还在原位。",
    };
  }
  if (/\b(apply_patch|mkdir|cp|mv|rm|tee|python3?|node)\b/.test(lower) || /[>]{1,2}/.test(text)) {
    return {
      kind: "write",
      title: `整理 ${target || "工作资料"}`,
      body: "他改写或整理了一处资料，让新的状态进入工作空间。",
    };
  }
  return {
    kind: "system",
    title: "执行本地动作",
    body: "他在工作空间里推进了一步操作，留下系统可回放的痕迹。",
  };
}

function describePatch(patch) {
  const text = String(patch || "");
  const match = text.match(/\*\*\* (Update|Add|Delete) File: ([^\n]+)/);
  if (!match) {
    return {
      kind: "write",
      title: "提交工坊改动",
      body: "他把一组文件改动写入工作空间，让后续居民能看到新的形态。",
    };
  }
  const verb = { Update: "修改", Add: "新增", Delete: "移除" }[match[1]] || "更新";
  return {
    kind: "write",
    title: `${verb} ${basename(match[2])}`,
    body: "他把这处资料改写成新的版本，改变会进入之后的城镇记忆。",
  };
}

function looksLikeShellAction(text) {
  return /\b(shell|cargo|npm|pnpm|yarn|bun|node|python3?|pytest|go|rg|grep|cat|sed|curl|apply_patch)\b/.test(
    String(text || "").toLowerCase(),
  );
}

function cleanActionTitle(text, kind = "") {
  const value = cleanupRichText(text || "");
  if (!value || looksLikeRawToolData(value)) return "记录了一次行动";
  if (kind === "error" || looksLikeTechnicalError(value)) return "遭遇裂隙";
  return value;
}

function cleanActionBody(text) {
  if (text === undefined || text === null) return "";
  const raw = typeof text === "string" ? text : JSON.stringify(text);
  if (looksLikeTechnicalError(raw)) return technicalErrorToLore(raw);
  const parsed = parseJsonLoose(raw);
  if (parsed) return summarizeRawValue(parsed);
  if (looksLikeRawToolData(raw)) return "";
  return cleanupRichText(raw)
    .replace(/\bprimitive_call\b/g, "本地动作")
    .replace(/\bplatform_call\b/g, "公共频道")
    .replace(/\badapter\.shell\b/g, "本地命令")
    .replace(/\badapter\.apply_patch\b/g, "文件补丁");
}

function summarizeRawValue(value) {
  if (!value || typeof value !== "object") return cleanupRichText(value || "");
  if (value.status === "denied" || value.status === "approval_required") return "行动被权限或环境挡住，暂时没有完成。";
  if (value.error) return technicalErrorToLore(value.error);
  if (value.output && typeof value.output === "string") {
    const nested = parseJsonLoose(value.output);
    if (nested) return summarizeRawValue(nested);
    return shortText(cleanupRichText(value.output), 180);
  }
  if (value.stdout_preview) return `系统返回：${shortText(value.stdout_preview, 150)}`;
  if (value.stderr_preview) return looksLikeTechnicalError(value.stderr_preview)
    ? technicalErrorToLore(value.stderr_preview)
    : `系统警告：${shortText(value.stderr_preview, 150)}`;
  if (value.message) return shortText(cleanupRichText(value.message), 180);
  return "";
}

function actionTitleFromName(name, input, kind) {
  const display = displayActionName(name, input);
  if (display) return display;
  return {
    read: "查阅工作资料",
    search: "寻找线索",
    write: "更新工作资料",
    social: "接触社会记录",
    ledger: "查看火种账本",
    message: "发送协作讯号",
    verify: "校验工坊状态",
    wait: "等待回应",
    error: "行动受阻",
    idle: "进入空闲",
    system: "记录系统动作",
  }[kind] || "记录了一次行动";
}

function displayActionName(name, input) {
  const raw = String(name || "");
  if (!raw || raw === "tool") return "";
  if (raw === "primitive_call") {
    const action = input?.payload?.action || input?.action || input?.primitive || "";
    if (action === "shell") return "执行本地动作";
    if (action === "apply_patch") return "提交文件补丁";
    return "记录本地动作";
  }
  if (raw === "platform_call") return "";
  return raw.replace(/_/g, " ");
}

function actionRawText(record, rawName) {
  if (record.raw) return String(record.raw);
  const parts = [];
  if (rawName) parts.push(`tool: ${rawName}`);
  if (record.input) parts.push(`input:\n${stringifyRawValue(record.input)}`);
  if (record.output) parts.push(`output:\n${stringifyRawValue(record.output)}`);
  if (!parts.length && record.summary && looksLikeRawToolData(record.summary)) parts.push(String(record.summary));
  return parts.join("\n\n");
}

function stringifyRawValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shouldShowActionRaw(event) {
  const raw = String(event.raw || "").trim();
  if (!raw || raw === event.body || raw === event.title) return false;
  return raw.length > 120 || looksLikeRawToolData(raw) || Boolean(event.sourceName);
}

function looksLikeRawToolData(text) {
  return /^\s*[\[{]/.test(String(text || "")) || /primitive_call|platform_call|tool_name|lowered_plan|stdout_preview|stderr_preview|resource_status|adapter\./i.test(String(text || ""));
}

function kindFromText(text) {
  const value = String(text || "").toLowerCase();
  if (/error|failed|denied|permission/.test(value)) return "error";
  if (/idle|stopped|none yet|空闲/.test(value)) return "idle";
  if (/bank|reward|energy|ledger|账本|能量/.test(value)) return "ledger";
  if (/call_agent|send_input|route_reply|inbox|message|reply/.test(value)) return "message";
  if (/agent_status|topology|collaboration/.test(value)) return "social";
  if (/patch|write|update|add file|delete file|mkdir|mv|cp|tee/.test(value)) return "write";
  if (/rg|grep|search|find|trace|events/.test(value)) return "search";
  if (/test|check|lint|build|verify/.test(value)) return "verify";
  if (/wait/.test(value)) return "wait";
  if (/read|cat|sed|head|tail|curl/.test(value)) return "read";
  return "system";
}

function actionKindClass(kind) {
  const value = String(kind || "").toLowerCase().replace(/[^a-z-]/g, "");
  return [
    "read",
    "search",
    "write",
    "social",
    "ledger",
    "message",
    "verify",
    "wait",
    "error",
    "idle",
    "system",
  ].includes(value)
    ? value
    : "system";
}

function actionKindLabel(kind) {
  return {
    read: "查阅",
    search: "追踪",
    write: "写入",
    social: "社会",
    ledger: "账本",
    message: "通信",
    verify: "校验",
    wait: "等待",
    error: "受阻",
    idle: "空闲",
    system: "记录",
  }[kind] || "记录";
}

function actionIcon(kind) {
  return {
    read: "阅",
    search: "寻",
    write: "写",
    social: "社",
    ledger: "账",
    message: "信",
    verify: "验",
    wait: "待",
    error: "!",
    idle: "闲",
    system: "记",
  }[kind] || "记";
}

function actionDefaultBody(kind) {
  return {
    read: "他查看了资料，用来更新当前判断。",
    search: "他沿着线索继续追踪，试图找到更可靠的入口。",
    write: "他把新的状态写入工作空间，让后续行动可以接上。",
    social: "他接触了公共协作记录，确认其他居民的存在和行踪。",
    ledger: "他查看资源与火种变化，判断接下来还能做什么。",
    message: "他向其他居民发出信号，等待关系网络给出回音。",
    verify: "他检查了一次运行结果，判断当前改动是否可靠。",
    wait: "他停下来等待回应，当前没有继续推进新的行动。",
    error: "这次行动没有成功，需要之后重新处理。",
    idle: "他暂时没有新的动作，当前处在待命状态。",
    system: "系统留下了一条行动痕迹，供之后回放。",
  }[kind] || "系统留下了一条行动痕迹，供之后回放。";
}

function eventTextForDisplay(event) {
  const text = cleanupRichText(String(event || ""));
  if (!text) return "";
  if (/^dispatching message to\b/i.test(text)) return "一封居民消息正在递送。";
  if (/^message dispatched to\b/i.test(text)) return "一封居民消息已经送出。";
  if (/^message enqueued\b/i.test(text)) return "一封居民消息已进入队列。";
  if (/^queued job-\d+/i.test(text)) return "新的居民任务已进入队列。";
  if (/\bturn started\b/i.test(text)) return "居民开始新一轮行动。";
  if (/\bturn completed\b/i.test(text)) return "居民完成了一轮行动。";
  if (/society.*energy[\s_.-]*spent/i.test(text)) return "营地火种发生消耗，账本记录了一次新的能量变化。";
  if (/attention[\s_.-]*state[\s_.-]*(update|updated|up)/i.test(text)) return "注意力纽带重新排列，几位居民开始靠近彼此。";
  if (/energy[\s_.-]*spent/i.test(text)) return "营地火种发生消耗。";
  if (looksLikeTechnicalError(text)) return technicalErrorToLore(text);
  return gameTermsForDisplay(text);
}

function loreTextForDisplay(text) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (looksLikeTechnicalError(line)) return technicalErrorToLore(line);
      return gameTermsForDisplay(line);
    })
    .join("\n");
}

function rewriteForDisplay(text) {
  return softenAgentSummary(loreTextForDisplay(text))
    .replace(/【近况】/g, "")
    .trim();
}

function gameTermsForDisplay(text) {
  return String(text || "")
    .replace(/\bAPI request failed\b/gi, "远方信标短暂失联")
    .replace(/\bStep\s+(\d+)/gi, "第 $1 刻")
    .replace(/\bAgent\b/g, "居民")
    .replace(/\bagent\b/g, "居民")
    .replace(/\benergy\b/gi, "火种");
}

function looksLikeTechnicalError(text) {
  return /api request|service unavailable|model_not_found|insufficient balance|http\s*\d{3}|error['"]?\s*:|503|500|429/i.test(
    String(text || ""),
  );
}

function technicalErrorToLore(text) {
  const value = String(text || "");
  if (/insufficient balance/i.test(value)) return "火种账本暂时见底，远方信标没有回应。";
  if (/model_not_found/i.test(value)) return "远方信标指向了不存在的星位，本轮行动暂时受阻。";
  if (/service unavailable|503/i.test(value)) return "远方信标短暂失联，城镇边缘出现一处裂隙。";
  if (/permission|denied/i.test(value)) return "通行凭证没有通过，这次行动被守门机制拦下。";
  return "行动遭遇裂隙，详情已收进原始记录。";
}

function actionSourceLabel(name, input, kind) {
  const raw = String(name || "");
  if (raw === "primitive_call" || raw === "shell" || raw === "apply_patch") return "本地工作空间";
  if (raw === "platform_call") {
    const pkg = input?.package || "";
    if (pkg === "bank" || pkg === "reward_oracle") return "火种系统";
    if (pkg === "collaboration") return "公共频道";
    return "平台接口";
  }
  if (kind === "ledger") return "火种系统";
  if (kind === "social" || kind === "message") return "公共频道";
  return "行动记录";
}

function normalizeActionStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["ok", "success", "succeeded", "done", "completed"].includes(value)) return "ok";
  if (["running", "active", "in_progress"].includes(value)) return "running";
  if (["pending", "approval_required", "waiting"].includes(value)) return "pending";
  if (["error", "failed", "fail", "denied"].includes(value)) return "error";
  if (["stopped", "idle", "closed"].includes(value)) return "idle";
  return "recorded";
}

function actionStatusLabel(status) {
  return {
    ok: "完成",
    running: "行动中",
    pending: "等待",
    error: "受阻",
    idle: "空闲",
    recorded: "记录",
  }[status] || "记录";
}

function actionStatusClass(status) {
  return `status-${normalizeActionStatus(status)}`;
}

function detectActionStatus(rawOutput, parsedOutput) {
  const raw = String(rawOutput || "");
  const parsedStatus = String(parsedOutput?.status || "").toLowerCase();
  if (parsedOutput?.error || /permission denied|tool error|failed|denied/i.test(raw)) return "error";
  if (parsedOutput?.success === false) return "error";
  if (["approval_required", "pending"].includes(parsedStatus)) return "pending";
  if (["running", "in_progress"].includes(parsedStatus)) return "running";
  if (["ok", "success", "succeeded", "done", "completed"].includes(parsedStatus) || parsedOutput?.success === true) return "ok";
  return "recorded";
}

function extractOutputText(output) {
  if (!output || typeof output !== "object") return "";
  if (typeof output.output === "string") return output.output;
  if (typeof output.stdout_preview === "string") return output.stdout_preview;
  if (typeof output.stderr_preview === "string") return output.stderr_preview;
  return "";
}

function likelyFileFromCommand(command) {
  const tokens = String(command || "").match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const ignored = new Set([
    "cat",
    "nl",
    "head",
    "tail",
    "less",
    "sed",
    "rg",
    "grep",
    "find",
    "ls",
    "pwd",
    "wc",
    "node",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "cargo",
    "pytest",
    "python",
    "python3",
    "go",
    "curl",
    "test",
    "check",
    "lint",
    "build",
  ]);
  for (const token of tokens.slice().reverse()) {
    const cleaned = token.replace(/^['"]|['"]$/g, "").replace(/[|;&]+$/g, "");
    const lower = cleaned.toLowerCase();
    if (!cleaned || cleaned.startsWith("-") || ignored.has(lower)) continue;
    if (/^\d+,\d+p$|^\d+p$|^\$p$/.test(lower)) continue;
    if (/^(true|false|null|&&|\|\|)$/.test(lower)) continue;
    if (cleaned.includes("://")) continue;
    if (cleaned.includes("/") || cleaned.includes(".") || /^[A-Z0-9_-]+$/i.test(cleaned)) return basename(cleaned);
  }
  return "";
}

function parseJsonLoose(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function basename(filePath) {
  return String(filePath || "").split("/").filter(Boolean).pop() || String(filePath || "");
}

function eventTexts(events) {
  return (events || [])
    .map((event) => event.summary || event.text || event.phase || event.kind || String(event))
    .map(eventTextForDisplay)
    .filter(Boolean)
    .slice(0, 8);
}

function deathEvents(events) {
  return eventTexts(events).filter((event) => /dead|died|死亡|濒死|exhaust/i.test(event));
}

function splitLines(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function summaryExcerpt(text, limit) {
  return loreTextForDisplay(text).replace(/【[^】]+】/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function shortText(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value) || 0));
}

function formatStatValue(value) {
  return Array.isArray(value) ? String(value.length) : formatNumber(value);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatUnixTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function compact(values) {
  return values.filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
