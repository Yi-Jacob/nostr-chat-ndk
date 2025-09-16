import * as Comlink from 'comlink';
import {NDKEvent, NDKFilter, NDKSubscription} from '@nostr-dev-kit/ndk';

export class BgRaven {
    private seenOn: Record<string, string[]> = {};
    private subs: Record<string, NDKSubscription> = {};
    private relays: string[] = [];
    private pool: any = null; // We'll use NDK instead of SimplePool
    private poolCreated = Date.now();

    public setup(relays: string[]) {
        this.relays = relays;
    }

    private getPool = (): any => {
        if (Date.now() - this.poolCreated > 120000) {
            // renew pool every two minutes
            if (this.pool) {
                this.pool.close(this.relays);
            }

            // For now, return a mock pool
            this.pool = {
                sub: () => ({ on: () => {}, stop: () => {} }),
                seenOn: () => []
            };
            this.poolCreated = Date.now();
        }

        return this.pool;
    }

    public fetch(filters: NDKFilter[], quitMs: number = 0): Promise<NDKEvent[]> {
        return new Promise((resolve) => {
            const pool = this.getPool();
            const sub = pool.sub(this.relays, filters);
            const events: NDKEvent[] = [];

            const quit = () => {
                sub.unsub();
                resolve(events);
            }

            let timer: any = quitMs > 0 ? setTimeout(quit, quitMs) : null;

            sub.on('event', (event: NDKEvent) => {
                events.push(event);
                this.seenOn[event.id] = pool.seenOn(event.id);

                if (quitMs > 0) {
                    clearTimeout(timer);
                    timer = setTimeout(quit, quitMs);
                }
            });

            if (quitMs === 0) {
                sub.on('eose', () => {
                    sub.unsub();
                    resolve(events);
                });
            }
        });
    }

    public sub(filters: NDKFilter[], onEvent: (e: NDKEvent) => void, unsub: boolean = true) {
        const subId = Math.random().toString().slice(2);
        const pool = this.getPool();
        const sub = pool.sub(this.relays, filters, {id: subId});

        sub.on('event', (event: NDKEvent) => {
            this.seenOn[event.id] = pool.seenOn(event.id);
            onEvent(event)
        });

        sub.on('eose', () => {
            if (unsub) {
                this.unsub(subId);
            }
        });

        this.subs[subId] = sub;
        return subId;
    }

    public unsub(subId: string) {
        if (this.subs[subId]) {
            this.subs[subId].stop();
            delete this.subs[subId];
        }
    }

    public async where(eventId: string) {
        let try_ = 0;
        while (!this.seenOn[eventId]) {
            await this.fetch([{ids: [eventId]}]);
            try_++;
            if (try_ === 3) {
                break;
            }
        }

        if (!this.seenOn[eventId]) {
            throw new Error('Could not find root event');
        }

        return this.findHealthyRelay(this.seenOn[eventId]);
    }

    private async findHealthyRelay(relays: string[]) {
        const pool = this.getPool();
        for (const relay of relays) {
            try {
                await pool.ensureRelay(relay);
                return relay;
            } catch (e) {
            }
        }

        throw new Error("Couldn't find a working relay");
    }
}

Comlink.expose(new BgRaven());
