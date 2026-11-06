import { useEffect, useState } from 'react';

/** The time now in milliseconds, refreshed every minute: the ages and the long-wait mark follow it by themselves. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
