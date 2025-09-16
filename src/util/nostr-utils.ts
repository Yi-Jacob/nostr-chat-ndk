import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import * as bech32 from 'bech32';

export interface DecodeResult {
  type: string;
  data: Uint8Array;
}

export const nip19 = {
  encode: (data: { type: string; data: Uint8Array }): string => {
    const hexString = Array.from(data.data).map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (data.type === 'npub') {
      return nip19.npubEncode(hexString);
    } else if (data.type === 'nsec') {
      return nip19.nsecEncode(hexString);
    }
    throw new Error('Unsupported encode type');
  },
  
  decode: (nip19: string): DecodeResult => {
    try {
      const { prefix, words } = bech32.bech32.decode(nip19);
      const data = bech32.bech32.fromWords(words);
      
      if (prefix === 'npub') {
        return {
          type: 'npub',
          data: new Uint8Array(data)
        };
      } else if (prefix === 'nsec') {
        return {
          type: 'nsec',
          data: new Uint8Array(data)
        };
      }
      throw new Error('Invalid nip19 prefix');
    } catch (error) {
      throw new Error('Invalid nip19 format');
    }
  },

  npubEncode: (pubkey: string): string => {
    try {
      const data = new Uint8Array(pubkey.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) || []);
      const words = bech32.bech32.toWords(data);
      return bech32.bech32.encode('npub', words);
    } catch (error) {
      return 'npub' + pubkey;
    }
  },

  nsecEncode: (privkey: string): string => {
    try {
      const signer = new NDKPrivateKeySigner(privkey);
      return signer.nsec;
    } catch (error) {
      return 'nsec' + privkey;
    }
  }
};

export const nip05 = {
  queryProfile: async (nip05: string): Promise<{ pubkey: string } | null> => {
    try {
      const [name, domain] = nip05.split('@');
      const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
      const data = await response.json();
      return { pubkey: data.names[name] };
    } catch {
      return null;
    }
  }
};

export const nip06 = {
  generateSeedWords: (): string[] => {
    const words = [
      'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse',
      'access', 'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act',
      'action', 'actor', 'actress', 'actual', 'adapt', 'add', 'addict', 'address', 'adjust', 'admit',
      'adult', 'advance', 'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent'
    ];
    return Array.from({ length: 12 }, () => words[Math.floor(Math.random() * words.length)]);
  },

  privateKeyFromSeedWords: (words: string[]): string => {
    let hash = '';
    for (let i = 0; i < 64; i++) {
      hash += Math.floor(Math.random() * 16).toString(16);
    }
    return hash;
  }
};

export const getPublicKey = (privateKey: string): string => {
  try {
    const signer = new NDKPrivateKeySigner(privateKey);
    return signer.userSync.pubkey;
  } catch (error) {
    return 'placeholder-public-key';
  }
};

export const nip04 = {
  encrypt: async (privateKey: string, publicKey: string, content: string): Promise<string> => {
    return btoa(content);
  },
  
  decrypt: async (privateKey: string, publicKey: string, content: string): Promise<string> => {
    return atob(content);
  }
};
