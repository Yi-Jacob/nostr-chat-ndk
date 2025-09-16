import NDKRaven from 'raven/ndk-raven';
import {NDKEvent} from '@nostr-dev-kit/ndk';
import {RelayDict} from 'types';

declare global {
    interface Window {
        raven?: NDKRaven;
        nostr?: {
            getPublicKey: () => Promise<string>;
            signEvent: (event: NDKEvent) => Promise<NDKEvent>;
            getRelays: () => Promise<RelayDict>;
            nip04: {
                encrypt: (pubkey: string, content: string) => Promise<string>;
                decrypt: (pubkey: string, content: string) => Promise<string>;
            };
        };
        requestPrivateKey: (data?: any) => Promise<string>;
    }
}
