'use client';

import { useEffect } from 'react';
import { track } from './track';

/** 挂在页面里就记一次「看到了这一页」。同一次挂载只报一次。 */
export function TrackView({ name, meta = '' }: { name: string; meta?: string }) {
  useEffect(() => {
    track(name, meta);
  }, [name, meta]);
  return null;
}
