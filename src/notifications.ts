import type { PushSubscriptionData } from "./types";

export const DEFAULT_NOTIFICATION_TIME = "09:00";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "";

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function isStandalonePwa(): boolean {
  return typeof window !== "undefined"
    && (window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
}

export function requiresStandalonePwa(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent) && !isStandalonePwa();
}

export function isNotificationConfigured(): boolean {
  return VAPID_PUBLIC_KEY.length > 0;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export async function getCurrentPushSubscription(): Promise<PushSubscriptionData | null> {
  if (!isPushSupported()) return null;
  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? serializeSubscription(subscription) : null;
}

export async function subscribeToPublicationNotifications(): Promise<PushSubscriptionData> {
  if (!isPushSupported()) throw new Error("この端末またはブラウザは通知に対応していません。");
  if (!isNotificationConfigured()) throw new Error("通知設定がまだ完了していません。管理者がVAPID公開鍵を設定する必要があります。");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした。iPhoneの通知設定を確認してください。");

  const registration = await getServiceWorkerRegistration();
  const current = await registration.pushManager.getSubscription();
  const subscription = current ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
  });
  return serializeSubscription(subscription);
}

export async function unsubscribeFromPublicationNotifications(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("通知サービスの準備に時間がかかっています。PWAを再読み込みしてから再試行してください。")), 10_000)),
  ]);
  return registration;
}

function serializeSubscription(subscription: PushSubscription): PushSubscriptionData {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh) throw new Error("通知の購読情報を取得できませんでした。");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      auth: json.keys.auth,
      p256dh: json.keys.p256dh,
    },
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
}
