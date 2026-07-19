import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

type WaitableEvent = { waitUntil(promise: Promise<unknown>): void };
type PushPayload = { title?: string; body?: string; url?: string; tag?: string };
type ServiceWorkerRuntime = {
  addEventListener(type: string, listener: (event: WaitableEvent & { data?: { json(): unknown; text(): string }; notification?: { close(): void; data?: { url?: string } } }) => void): void;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: { matchAll(options: { type: string; includeUncontrolled: boolean }): Promise<Array<{ url: string; focus(): Promise<unknown> }>>; openWindow(url: string): Promise<unknown> };
};

declare global {
  interface Window {
    __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
  }
}

precacheAndRoute(self.__WB_MANIFEST);
const worker = self as unknown as ServiceWorkerRuntime;
cleanupOutdatedCaches();

worker.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = event.data?.json() as PushPayload ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }
  const title = payload.title ?? "note記事の公開予定";
  const options: NotificationOptions = {
    body: payload.body ?? "公開予定の記事があります。",
    tag: payload.tag ?? "note-article-publication",
    data: { url: payload.url ?? "/note-article-manager/" },
    icon: "/note-article-manager/icon.svg",
    badge: "/note-article-manager/icon.svg",
  };
  event.waitUntil(worker.registration.showNotification(title, options));
});

worker.addEventListener("notificationclick", (event) => {
  const url = event.notification?.data?.url ?? "/note-article-manager/";
  event.notification?.close();
  event.waitUntil((async () => {
    const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => client.url.includes("/note-article-manager/"));
    if (existing) {
      await existing.focus();
      return;
    }
    await worker.clients.openWindow(url);
  })());
});
