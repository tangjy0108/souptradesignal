import { useState, useEffect, useRef } from 'react';

export type Alert = {
  id: string;
  symbol: string;
  price: number;
  condition: 'above' | 'below';
  triggered: boolean;
  createdAt: number;
};

function safeGetAlerts(): Alert[] {
  try { return JSON.parse(localStorage.getItem('priceAlerts') || '[]'); }
  catch { return []; }
}

function safeSaveAlerts(alerts: Alert[]) {
  try { localStorage.setItem('priceAlerts', JSON.stringify(alerts)); }
  catch {}
}

// 統一通知函數 — 透過 SW postMessage，最穩定
export async function sendNotification(title: string, body: string, tag = 'quantview') {
  try {
    if (Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      // 優先用 postMessage（iOS 17.4+ 支援）
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title, body, tag });
        return;
      }
      // fallback: showNotification
      await reg.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag, renotify: true });
    } else {
      new Notification(title, { body, icon: '/icon-192.png' });
    }
  } catch (e) {
    // 最後 fallback
    try { new Notification(title, { body }); } catch {}
  }
}

export function useAlerts(currentPrice: number, currentSymbol: string) {
  const [alerts, setAlerts] = useState<Alert[]>(safeGetAlerts);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default');
  const prevPriceRef = useRef<number>(0);

  useEffect(() => {
    try { setNotifPermission(Notification.permission); } catch {}
  }, []);

  useEffect(() => { safeSaveAlerts(alerts); }, [alerts]);

  useEffect(() => {
    if (!currentPrice || currentPrice === prevPriceRef.current) return;
    const prev = prevPriceRef.current;
    prevPriceRef.current = currentPrice;
    if (!prev) return;

    setAlerts(prev_ => prev_.map(alert => {
      if (alert.triggered || alert.symbol !== currentSymbol) return alert;
      const triggered =
        (alert.condition === 'above' && prev < alert.price && currentPrice >= alert.price) ||
        (alert.condition === 'below' && prev > alert.price && currentPrice <= alert.price);
      if (triggered) {
        const direction = alert.condition === 'above' ? '突破' : '跌破';
        sendNotification(
          `🔔 ${alert.symbol} 價格警報`,
          `${alert.symbol} 已${direction} ${alert.price.toLocaleString()}，目前：${currentPrice.toLocaleString()}`,
          `price-${alert.id}`
        );
        return { ...alert, triggered: true };
      }
      return alert;
    }));
  }, [currentPrice, currentSymbol]);

  const requestPermission = async () => {
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
      return result;
    } catch { return 'denied' as NotificationPermission; }
  };

  const addAlert = (symbol: string, price: number, condition: 'above' | 'below') => {
    setAlerts(p => [...p, { id: Date.now().toString(), symbol, price, condition, triggered: false, createdAt: Date.now() }]);
  };

  const removeAlert = (id: string) => setAlerts(p => p.filter(a => a.id !== id));
  const clearTriggered = () => setAlerts(p => p.filter(a => !a.triggered));

  return { alerts, addAlert, removeAlert, clearTriggered, notifPermission, requestPermission };
}
