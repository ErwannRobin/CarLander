import type { GameEvent, GameEventType } from './types';

type Handler<E> = (event: E) => void;
type EventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

/** Tiny typed pub/sub used to fan game events out to VFX, audio, camera and UI. */
export class EventBus {
  private handlers = new Map<GameEventType | '*', Set<Handler<GameEvent>>>();

  on<T extends GameEventType>(type: T, handler: Handler<EventOf<T>>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<GameEvent>);
    return () => set!.delete(handler as Handler<GameEvent>);
  }

  /** Subscribe to every event. */
  onAny(handler: Handler<GameEvent>): () => void {
    let set = this.handlers.get('*');
    if (!set) {
      set = new Set();
      this.handlers.set('*', set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(event: GameEvent): void {
    const typed = this.handlers.get(event.type);
    if (typed) for (const h of [...typed]) h(event);
    const any = this.handlers.get('*');
    if (any) for (const h of [...any]) h(event);
  }

  clear(): void {
    this.handlers.clear();
  }
}
