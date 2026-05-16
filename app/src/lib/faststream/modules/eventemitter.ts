type Listener = (...args: any[]) => void;

export class EventEmitter {
  private listeners: Map<string, Set<Listener>> = new Map();

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of set) {
      try {
        listener(...args);
      } catch (e) {
        console.error(`Error in event listener for "${event}":`, e);
      }
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}

export class EmitterRelay {
  private emitters: EventEmitter[];

  constructor(emitters: EventEmitter[]) {
    this.emitters = emitters;
  }

  emit(event: string, ...args: any[]): boolean {
    let handled = false;
    for (const emitter of this.emitters) {
      if (emitter.emit(event, ...args)) {
        handled = true;
      }
    }
    return handled;
  }
}
