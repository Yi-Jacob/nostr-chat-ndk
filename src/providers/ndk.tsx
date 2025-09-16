import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  PropsWithChildren,
} from 'react';
import NDK, { NDKPrivateKeySigner, NDKNip07Signer } from '@nostr-dev-kit/ndk';
import { getRelays } from 'local-storage';
import { RelayDict } from 'types';

interface NDKContextType {
  ndk?: NDK;
  canPublishEvents: boolean;
  isConnected: boolean;
  createSigner: (privKey: string | any) => Promise<any>;
}

const NDKContext = createContext<NDKContextType>({ 
  canPublishEvents: false, 
  isConnected: false,
  createSigner: async () => null
});
const NDKProvider = ({ children }: PropsWithChildren) => {
  const [ndk, setNDK] = useState<NDK | undefined>(undefined);
  const [canPublishEvents, setCanPublishEvents] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [relays, setRelays] = useState<RelayDict>({});

  useEffect(() => {
    getRelays().then(r => {
      setRelays(r);
    });
  }, []);

  useEffect(() => {
    const initNDK = async () => {
      const readRelays = Object.keys(relays).filter(r => relays[r].read);
      const writeRelays = Object.keys(relays).filter(r => relays[r].write);
      
      if (readRelays.length === 0) {
        const defaultRelays = [
          'wss://relay.damus.io',
          'wss://nos.lol',
          'wss://relay.nostr.band',
          'wss://relay.nostr.wine',
          'wss://relay.mostr.pub'
        ];
        readRelays.push(...defaultRelays);
        writeRelays.push(...defaultRelays);
      }

      const ndkInstance = new NDK({
        explicitRelayUrls: readRelays,
      });

      try {
        const connectPromise = ndkInstance.connect();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 10000)
        );
        
        await Promise.race([connectPromise, timeoutPromise]);
        setIsConnected(true);
      } catch (error) {
        console.warn('Failed to connect to some relays:', error);
        setIsConnected(false);
      }

      setNDK(ndkInstance);
    };

    if (Object.keys(relays).length > 0) {
      initNDK();
    }
  }, [relays]);

  const createSigner = async (privKey: string | any) => {
    if (!ndk) return;

    let actualPrivKey = privKey;
    
    if (typeof privKey === 'object' && privKey !== null) {
      return null;
    }
    
    if (typeof privKey === 'string' && privKey.startsWith('nsec')) {
      try {
        const { nip19 } = await import('util/nostr-utils');
        const dec = nip19.decode(privKey);
        actualPrivKey = Array.from(dec.data).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (error) {
        return null;
      }
    }

    if (actualPrivKey === 'nip07') {
      try {
        const signer = new NDKNip07Signer();
        ndk.signer = signer;
        setCanPublishEvents(true);
        return signer;
      } catch (error) {
        return null;
      }
    } else if (actualPrivKey && actualPrivKey !== 'none') {
      try {
        const signer = new NDKPrivateKeySigner(actualPrivKey);
        ndk.signer = signer;
        setCanPublishEvents(true);
        return signer;
      } catch (error) {
        return null;
      }
    }

    setCanPublishEvents(false);
    return null;
  };

  const contextValue: NDKContextType = {
    ndk,
    canPublishEvents,
    isConnected,
    createSigner,
  };

  return (
    <NDKContext.Provider value={contextValue}>
      {ndk ? children : null}
    </NDKContext.Provider>
  );
};

const useNDK = () => {
  const context = useContext(NDKContext);
  if (context === undefined) {
    throw new Error('useNDK must be used within an NDKProvider');
  }
  return context;
};

export { NDKProvider, useNDK };
export default NDKProvider