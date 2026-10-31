import type { Plugin } from "@opencode/plugin/tui";
import type { NativeFixture } from "./fixture.js";
import { deferred, record } from "./support.js";

export type RecordedToast = Parameters<Plugin.Context["ui"]["toast"]["show"]>[0];
type Location = NonNullable<Plugin.Context["location"]>;

function unavailable(capability: string): never {
  throw new Error(`Headless toast test does not supply ${capability}`);
}

/** Full typed context, not a cast to a fabricated renderer. Unused host
 * capabilities fail immediately if the production handler starts using them. */
export function recordingTuiContext(input: {
  client: NativeFixture["client"];
  location: Location | undefined;
  defaultLocation: Location;
  show: (toast: RecordedToast) => void;
}): Plugin.Context {
  return {
    options: {}, app: { version: "2.2.2", channel: "test" }, themeMode: "dark",
    client: input.client, location: input.location,
    get renderer() { return unavailable("renderer"); },
    get attention() { return unavailable("attention"); },
    get theme() { return unavailable("theme"); },
    get markdown() { return unavailable("markdown"); },
    get keymap() { return unavailable("keymap"); },
    get storage() { return unavailable("storage"); },
    data: {
      get on() { return unavailable("data.on"); },
      get listen() { return unavailable("data.listen"); },
      get session() { return unavailable("data.session"); },
      get project() { return unavailable("data.project"); },
      get shell() { return unavailable("data.shell"); },
      location: {
        default: () => input.defaultLocation,
        get sync() { return unavailable("data.location.sync"); },
        get invalidate() { return unavailable("data.location.invalidate"); },
        get vcs() { return unavailable("data.location.vcs"); },
        get agent() { return unavailable("data.location.agent"); },
        get command() { return unavailable("data.location.command"); },
        get integration() { return unavailable("data.location.integration"); },
        get mcp() { return unavailable("data.location.mcp"); },
        get model() { return unavailable("data.location.model"); },
        get provider() { return unavailable("data.location.provider"); },
        get reference() { return unavailable("data.location.reference"); },
        get skill() { return unavailable("data.location.skill"); },
      },
    },
    ui: {
      toast: { show: input.show },
      get dialog() { return unavailable("ui.dialog"); },
      get format() { return unavailable("ui.format"); },
      get router() { return unavailable("ui.router"); },
      get panel() { return unavailable("ui.panel"); },
      get tabs() { return unavailable("ui.tabs"); },
      get model() { return unavailable("ui.model"); },
      get slot() { return unavailable("ui.slot"); },
    },
  };
}

export interface ObservedReceipt {
  invocationID: string;
  displayed: boolean;
  directory: string | undefined;
}

async function waitForRelease(release: Promise<void>, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Owned receipt gate stopped");
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("Owned receipt gate stopped"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { await Promise.race([release, aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

/** Observe the production handler's HTTP request, never synthesize an ack or
 * replace its RPC subscription. Every request goes through the pinned SDK and
 * the owned native server; only receipt dispatch is held until test release. */
export function nativeReceiptGate(fixture: NativeFixture, order: string[]) {
  const release = deferred<void>();
  const started = deferred<ObservedReceipt>();
  const replied = deferred<{ status: number; accepted: boolean }>();
  const requests: ObservedReceipt[] = [];
  const client = fixture.makeClient(async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/rpc/play-nice/receipt") return fetch(request);
    // Record synchronously at transport entry, before parsing yields. Otherwise
    // a receipt started BEFORE toast.show could appear later in the trace.
    order.push("receipt-attempt");
    const body: unknown = await request.clone().json();
    if (!record(body) || !record(body.input) || typeof body.input.invocationID !== "string" || typeof body.input.displayed !== "boolean") {
      throw new Error("Unexpected production receipt request shape");
    }
    // @opencode/client 2.2.2 appendQuery recursively flattens object keys:
    // { location: { directory } } -> location[directory]=..., not JSON.
    const directory = url.searchParams.get("location[directory]") ?? undefined;
    const receipt = {
      invocationID: body.input.invocationID, displayed: body.input.displayed,
      directory,
    };
    requests.push(receipt);
    started.resolve(receipt);
    await waitForRelease(release.promise, request.signal);
    order.push("receipt-dispatched");
    const response = await fetch(request);
    const value: unknown = await response.clone().json();
    if (!record(value) || !record(value.output) || typeof value.output.accepted !== "boolean") {
      throw new Error("Unexpected native receipt response shape");
    }
    replied.resolve({ status: response.status, accepted: value.output.accepted });
    return response;
  });
  return { client, requests, started: started.promise, replied: replied.promise, release: () => release.resolve() };
}
