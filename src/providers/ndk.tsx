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

// Create a context to store the NDK instance
const NDKContext = createContext<NDKContextType>({ 
  canPublishEvents: false, 
  isConnected: false,
  createSigner: async () => null
});

// NDKProvider function component
const NDKProvider = ({ children }: PropsWithChildren) => {
  const [ndk, setNDK] = useState<NDK | undefined>(undefined);
  const [canPublishEvents, setCanPublishEvents] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [relays, setRelays] = useState<RelayDict>({});

  // Load relays from local storage
  useEffect(() => {
    getRelays().then(r => {
      setRelays(r);
    });
  }, []);

  // Initialize NDK instance
  useEffect(() => {
    const initNDK = async () => {
      const readRelays = Object.keys(relays).filter(r => relays[r].read);
      const writeRelays = Object.keys(relays).filter(r => relays[r].write);
      
      if (readRelays.length === 0) {
        // Use default relays if none configured
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
        // Connect to the relays with timeout
        const connectPromise = ndkInstance.connect();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 10000)
        );
        
        await Promise.race([connectPromise, timeoutPromise]);
        setIsConnected(true);
      } catch (error) {
        console.warn('Failed to connect to some relays:', error);
        // Still set NDK instance even if some relays fail
        setIsConnected(false);
      }

      // Set the NDK instance in the state
      setNDK(ndkInstance);
    };

    if (Object.keys(relays).length > 0) {
      initNDK();
    }
  }, [relays]);

  // Create signer based on private key or NIP-07
  const createSigner = async (privKey: string | any) => {
    if (!ndk) return;

    // Handle case where privKey might be an object or nsec string
    let actualPrivKey = privKey;
    
    if (typeof privKey === 'object' && privKey !== null) {
      return null;
    }
    
    if (typeof privKey === 'string' && privKey.startsWith('nsec')) {
      try {
        // Decode nsec to hex if it's still in nsec format
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

  // Expose signer creation method
  const contextValue: NDKContextType = {
    ndk,
    canPublishEvents,
    isConnected,
    createSigner,
  };

  // Return the provider with the NDK instance
  return (
    <NDKContext.Provider value={contextValue}>
      {ndk ? children : null}
    </NDKContext.Provider>
  );
};

// Custom hook to access NDK instance from the context
const useNDK = () => {
  const context = useContext(NDKContext);
  if (context === undefined) {
    throw new Error('useNDK must be used within an NDKProvider');
  }
  return context;
};

export { NDKProvider, useNDK };
export default NDKProvider