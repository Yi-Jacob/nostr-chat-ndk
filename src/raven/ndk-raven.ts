import {
  NDKEvent,
  NDKFilter,
  NDKKind,
  NDKRelay,
  NDKRelaySet,
  NDKSubscription,
  NDKTag,
  NDKPrivateKeySigner,
} from '@nostr-dev-kit/ndk';
import { TypedEventEmitter } from 'raven/helper/event-emitter';
import {
  PrivKey,
  Channel,
  ChannelMessageHide,
  ChannelUpdate,
  ChannelUserMute,
  DirectMessage,
  EventDeletion,
  Metadata,
  MuteList,
  Profile,
  PublicMessage,
  Reaction,
  ReadMarkMap,
} from 'types';
import chunk from 'lodash.chunk';
import uniq from 'lodash.uniq';
import { getRelays } from 'local-storage';
import { GLOBAL_CHAT, MESSAGE_PER_PAGE } from 'const';
import { notEmpty } from 'util/misc';

enum NewKinds {
  MuteList = 10000,
  Arbitrary = 30078
}

export enum RavenEvents {
  Ready = 'ready',
  DMsDone = 'dms_done',
  SyncDone = 'sync_done',
  ProfileUpdate = 'profile_update',
  ChannelCreation = 'channel_creation',
  ChannelUpdate = 'channel_update',
  EventDeletion = 'event_deletion',
  PublicMessage = 'public_message',
  DirectMessage = 'direct_message',
  ChannelMessageHide = 'channel_message_hide',
  ChannelUserMute = 'channel_user_mute',
  MuteList = 'mute_list',
  LeftChannelList = 'left_channel_list',
  Reaction = 'reaction',
  ReadMarkMap = 'read_mark_map'
}

type EventHandlerMap = {
  [RavenEvents.Ready]: () => void;
  [RavenEvents.DMsDone]: () => void;
  [RavenEvents.SyncDone]: () => void;
  [RavenEvents.ProfileUpdate]: (data: Profile[]) => void;
  [RavenEvents.ChannelCreation]: (data: Channel[]) => void;
  [RavenEvents.ChannelUpdate]: (data: ChannelUpdate[]) => void;
  [RavenEvents.EventDeletion]: (data: EventDeletion[]) => void;
  [RavenEvents.PublicMessage]: (data: PublicMessage[]) => void;
  [RavenEvents.DirectMessage]: (data: DirectMessage[]) => void;
  [RavenEvents.ChannelMessageHide]: (data: ChannelMessageHide[]) => void;
  [RavenEvents.ChannelUserMute]: (data: ChannelUserMute[]) => void;
  [RavenEvents.MuteList]: (data: MuteList) => void;
  [RavenEvents.LeftChannelList]: (data: string[]) => void;
  [RavenEvents.Reaction]: (data: Reaction[]) => void;
  [RavenEvents.ReadMarkMap]: (data: ReadMarkMap) => void;
};

class NDKRaven extends TypedEventEmitter<RavenEvents, EventHandlerMap> {
  private ndk: any; // NDK instance will be injected
  private readonly priv: PrivKey;
  private readonly pub: string;
  private readRelays: string[] = [];
  private writeRelays: string[] = [];
  private relaysLoaded = false;

  private eventQueue: NDKEvent[] = [];
  private eventQueueTimer: any;
  private eventQueueFlag = true;
  private eventQueueBuffer: NDKEvent[] = [];

  private nameCache: Record<string, number> = {};

  private subscriptions: NDKSubscription[] = [];

  constructor(ndk: any, priv: string, pub: string) {
    super();

    this.ndk = ndk;
    this.priv = priv;
    this.pub = pub;

    this.ensureSigner();

    this.loadRelaysAndInit();
  }

  private async ensureSigner() {
    if (!this.ndk || !this.priv || this.priv === 'none' || this.priv === 'nip07') {
      return;
    }

    try {
      let actualPrivKey = this.priv;
      
      if (typeof this.priv === 'string' && this.priv.startsWith('nsec')) {
        const { nip19 } = await import('util/nostr-utils');
        const dec = nip19.decode(this.priv);
        actualPrivKey = Array.from(dec.data).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      
      if (typeof actualPrivKey !== 'string' || actualPrivKey.length !== 64) {
        return;
      }
      
      if (!/^[0-9a-fA-F]{64}$/.test(actualPrivKey)) {
        return;
      }
      
      const signer = new NDKPrivateKeySigner(actualPrivKey);
      this.ndk.signer = signer;
    } catch (error) {
    }
  }

  private async loadRelaysAndInit() {
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (this.ndk && this.ndk.pool) {
        const relayUrls = Array.from(this.ndk.pool.relays.keys()) as string[];
        this.readRelays = relayUrls;
        this.writeRelays = relayUrls;
      } else {
        const relays = await getRelays();
        this.readRelays = Object.keys(relays).filter(r => relays[r].read);
        this.writeRelays = Object.keys(relays).filter(r => relays[r].write);
      }
      
      this.relaysLoaded = true;

      if (this.priv && this.pub) {
        await this.init();
      }
    } catch (error) {
      this.emit(RavenEvents.Ready);
    }
  }

  private async init() {
    let userEvents: NDKEvent[] = [];
    
    try {
      userEvents = await this.fetchEventsWithTimeout([{
        authors: [this.pub],
      }], 30000);
      
      userEvents
        .filter(e => e.kind !== NDKKind.ChannelMessage)
        .forEach(e => this.pushToEventBuffer(e));
      this.emit(RavenEvents.Ready);

      const incomingDms = await this.fetchEventsWithTimeout([{
        kinds: [NDKKind.EncryptedDirectMessage],
        '#p': [this.pub]
      }], 30000);
      incomingDms.forEach(e => this.pushToEventBuffer(e));
      this.emit(RavenEvents.DMsDone);

      const deletions = userEvents
        .filter(x => x.kind === NDKKind.EventDeletion)
        .map(x => this.findTagValue(x, 'e'))
        .filter(notEmpty);

      const channelIds = uniq(userEvents.map(x => {
        if (x.kind === NDKKind.ChannelCreation) {
          return x.id;
        }

        if (x.kind === NDKKind.ChannelMessage) {
          return this.findTagValue(x, 'e');
        }

        return null;
      }).filter(notEmpty).filter(x => !deletions.includes(x)).filter(notEmpty));

      if (!channelIds.includes(GLOBAL_CHAT.id)) {
        channelIds.push(GLOBAL_CHAT.id);
      }


      const channels = await this.fetchEvents([
        ...chunk(channelIds, 10).map(x => ({
          kinds: [NDKKind.ChannelCreation],
          ids: x
        }))
      ]);
      channels.forEach(x => this.pushToEventBuffer(x));
      const filters = channels.map(x => x.id).map(x => ([
        {
          kinds: [NDKKind.ChannelMetadata, NDKKind.EventDeletion],
          '#e': [x],
        },
        {
          kinds: [NDKKind.ChannelMessage],
          '#e': [x],
          limit: MESSAGE_PER_PAGE
        }
      ])).flat();


      const promises = chunk(filters, 6).map(f => 
        this.fetchEvents(f).then(events => {
          events.forEach(ev => this.pushToEventBuffer(ev));
        })
      );
      await Promise.all(promises);

      this.emit(RavenEvents.SyncDone);
    } catch (error) {
      this.emit(RavenEvents.Ready);
      this.emit(RavenEvents.DMsDone);
      this.emit(RavenEvents.SyncDone);
    }
  }

  public isSyntheticPrivKey = () => {
    return this.priv === 'nip07' || this.priv === 'none';
  }

  public async fetchEvents(filters: NDKFilter[]): Promise<NDKEvent[]> {
    if (!this.ndk || !this.relaysLoaded) return [];

    try {
      const events: NDKEvent[] = [];
      
      for (const filter of filters) {
        const relaySet = this.createRelaySet(this.readRelays);
        const subscription = this.ndk.subscribe(filter, { 
          closeOnEose: true,
          relaySet: relaySet
        });
        
        await new Promise<void>((resolve) => {
          subscription.on('event', (event: NDKEvent) => {
            events.push(event);
          });
          
          subscription.on('eose', () => {
            resolve();
          });
        });
      }

      return events;
    } catch (error) {
      return [];
    }
  }

  public async fetchEventsWithTimeout(filters: NDKFilter[], timeoutMs: number = 30000): Promise<NDKEvent[]> {
    if (!this.ndk || !this.relaysLoaded) return [];

    try {
      const events: NDKEvent[] = [];
      
      for (const filter of filters) {
        const relaySet = this.createRelaySet(this.readRelays);
        const subscription = this.ndk.subscribe(filter, { 
          closeOnEose: true,
          relaySet: relaySet
        });
        
        await Promise.race([
          new Promise<void>((resolve) => {
            subscription.on('event', (event: NDKEvent) => {
              events.push(event);
            });
            
            subscription.on('eose', () => {
              resolve();
            });
          }),
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              subscription.stop();
              reject(new Error(`Fetch timeout after ${timeoutMs}ms`));
            }, timeoutMs);
          })
        ]);
      }

      return events;
    } catch (error) {
      return [];
    }
  }

  public async fetchPrevMessages(channel: string, until: number): Promise<NDKEvent[]> {
    const events = await this.fetchEvents([{
      kinds: [NDKKind.ChannelMessage],
      '#e': [channel],
      until,
      limit: MESSAGE_PER_PAGE
    }]);

    events.forEach((ev) => {
      this.pushToEventBuffer(ev);
    });

    return events;
  }

  public async fetchChannel(id: string): Promise<Channel | null> {
    const filters: NDKFilter[] = [
      {
        kinds: [NDKKind.ChannelCreation],
        ids: [id]
      },
      {
        kinds: [NDKKind.ChannelMetadata],
        '#e': [id],
        limit: 1
      }
    ];

    const events = await this.fetchEvents(filters);
    const channelEvent = events.find(e => e.kind === NDKKind.ChannelCreation);
    const metadataEvent = events.find(e => e.kind === NDKKind.ChannelMetadata);

    if (!channelEvent) return null;

    const channel: Channel = {
      id: channelEvent.id,
      name: metadataEvent?.content ? JSON.parse(metadataEvent.content).name : 'Unknown',
      about: metadataEvent?.content ? JSON.parse(metadataEvent.content).about : '',
      picture: metadataEvent?.content ? JSON.parse(metadataEvent.content).picture : '',
      created: channelEvent.created_at || Math.floor(Date.now() / 1000),
      creator: channelEvent.pubkey
    };

    return channel;
  }

  public async sendPublicMessage(channel: Channel, message: string, mentions: string[] = [], rootId?: string): Promise<void> {
    if (!this.ndk || !this.canPublishEvents()) return;

    const event = new NDKEvent(this.ndk);
    event.kind = NDKKind.ChannelMessage;
    event.content = message;
    event.created_at = Math.floor(Date.now() / 1000);

    const tags: NDKTag[] = [
      ['e', channel.id, '', 'root']
    ];

    if (rootId) {
      tags.push(['e', rootId, '', 'reply']);
    }

    mentions.forEach(mention => {
      tags.push(['p', mention]);
    });

    event.tags = tags;

    try {
      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);
    } catch (error) {
      throw error;
    }
  }

  public async sendDirectMessage(peer: string, message: string, mentions?: string[], rootId?: string): Promise<void> {
    if (!this.ndk || !this.canPublishEvents()) return;

    const event = new NDKEvent(this.ndk);
    event.kind = NDKKind.EncryptedDirectMessage;
    event.created_at = Math.floor(Date.now() / 1000);

    const tags: NDKTag[] = [
      ['p', peer]
    ];

    if (rootId) {
      tags.push(['e', rootId, '', 'root']);
    }

    event.tags = tags;

    try {
      const encryptedContent = await this.encrypt(peer, message);
      event.content = encryptedContent;

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);
    } catch (error) {
      throw error;
    }
  }

  public async createChannel(meta: Metadata): Promise<Channel> {
    if (!this.ndk || !this.canPublishEvents()) throw new Error('Cannot publish events');

    const event = new NDKEvent(this.ndk);
    event.kind = NDKKind.ChannelCreation;
    event.content = JSON.stringify(meta);
    event.created_at = Math.floor(Date.now() / 1000);

    try {
      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);

      const channel: Channel = {
        id: event.id,
        created: event.created_at,
        creator: event.pubkey,
        ...this.normalizeMetadata(meta)
      };

      this.emit(RavenEvents.ChannelCreation, [channel]);

      return channel;
    } catch (error) {
      throw error;
    }
  }

  public async loadProfiles(pubkeys: string[]): Promise<void> {
    if (!this.ndk || pubkeys.length === 0) return;

    const filter: NDKFilter = {
      kinds: [NDKKind.Metadata],
      authors: pubkeys
    };

    try {
      const events = await this.fetchEvents([filter]);
      const profiles: Profile[] = events.map(event => {
        const normalizedContent = this.parseProfileContent(event.content);
        
        return {
          id: event.id,
          creator: event.pubkey,
          created: event.created_at || Math.floor(Date.now() / 1000),
          ...normalizedContent
        };
      });

      this.emit(RavenEvents.ProfileUpdate, profiles);
    } catch (error) {
    }
  }

  public async updateProfile(profile: Metadata): Promise<void> {
    if (!this.ndk || !this.relaysLoaded) {
      throw new Error('NDK not ready');
    }

    if (!this.ndk.signer) {
      throw new Error('No signer available - please ensure your private key is properly set');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.Metadata;
      event.content = JSON.stringify({
        name: profile.name,
        about: profile.about,
        picture: profile.picture
      });
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      
      if (relaySet) {
        await event.publish(relaySet);
        
        const normalizedProfile = this.normalizeMetadata(profile);
        const updatedProfile: Profile = {
          id: event.id,
          creator: this.pub,
          created: event.created_at || Math.floor(Date.now() / 1000),
          ...normalizedProfile
        };
        
        this.emit(RavenEvents.ProfileUpdate, [updatedProfile]);
      }
    } catch (error) {
      throw error;
    }
  }

  public startListening(): void {
    if (!this.ndk) return;

    const filter: NDKFilter = {
      kinds: [
        NDKKind.Text,
        NDKKind.EncryptedDirectMessage,
        NDKKind.ChannelMessage,
        NDKKind.ChannelCreation,
        NDKKind.ChannelMetadata,
        NDKKind.EventDeletion,
        NDKKind.Reaction,
        NDKKind.ChannelHideMessage,
        NDKKind.ChannelMuteUser,
        10000, // MuteList
        30078  // Arbitrary
      ],
      '#p': [this.pub]
    };

    const subscription = this.ndk.subscribe(filter, { closeOnEose: false });
    
    subscription.on('event', (event: NDKEvent) => {
      this.pushToEventBuffer(event);
    });

    this.subscriptions.push(subscription);
  }

  public listen(channelIds: string[], since: number): void {
    if (!this.ndk) return;

    const filter: NDKFilter = {
      kinds: [NDKKind.ChannelMessage],
      '#e': channelIds,
      since
    };

    const subscription = this.ndk.subscribe(filter, { closeOnEose: true });
    
    subscription.on('event', (event: NDKEvent) => {
      this.pushToEventBuffer(event);
    });

    this.subscriptions.push(subscription);
  }

  public stopListening(): void {
    this.subscriptions.forEach(sub => sub.stop());
    this.subscriptions = [];
  }

  private createRelaySet(relayUrls: string[]): NDKRelaySet | undefined {
    if (!this.ndk || relayUrls.length === 0) return undefined;

    const relaySet = new Set<NDKRelay>();
    relayUrls.forEach(url => {
      const relay = this.ndk.pool.getRelay(url);
      if (relay) {
        relaySet.add(relay);
      }
    });

    return new NDKRelaySet(relaySet, this.ndk);
  }

  private pushToEventBuffer(event: NDKEvent): void {
    const isDuplicate = this.eventQueueBuffer.some(e => e.id === event.id);
    if (isDuplicate) {
      return;
    }
    
    this.eventQueueBuffer.push(event);
    
    if (this.eventQueueFlag) {
      this.eventQueueFlag = false;
      setTimeout(() => this.processEventQueue(), 100);
    }
  }

  private async processEventQueue(): Promise<void> {
    this.eventQueueFlag = false;
    this.eventQueue = [...this.eventQueueBuffer];
    this.eventQueueBuffer = [];

    await this.processProfiles();
    await this.processPublicMessages();
    await this.processDirectMessages();
    await this.processChannelMessageHides();
    await this.processChannelUserMutes();
    await this.processReactions();
    await this.processEventDeletions();
    await this.processMuteList();
    await this.processChannelCreations();
    await this.processChannelUpdates();

    this.eventQueueFlag = true;
  }

  private async processProfiles(): Promise<void> {
    const profiles: Profile[] = this.eventQueue
      .filter(x => x.kind === NDKKind.Metadata)
      .map(ev => {
        const normalizedContent = this.parseProfileContent(ev.content);
        
        return {
          id: ev.id,
          creator: ev.pubkey,
          created: ev.created_at || Math.floor(Date.now() / 1000),
          ...normalizedContent
        };
      });

    if (profiles.length > 0) {
      this.emit(RavenEvents.ProfileUpdate, profiles);
    }
  }

  private async processPublicMessages(): Promise<void> {
    const publicMessages: PublicMessage[] = this.eventQueue
      .filter(x => x.kind === NDKKind.ChannelMessage)
      .map(ev => {
        const root = this.findNip10MarkerValue(ev, 'root');
        const reply = this.findNip10MarkerValue(ev, 'reply');
        const mentions = this.filterTagValue(ev, 'p').map(x => x?.[1]).filter(notEmpty);

        return {
          id: ev.id,
          root: root || '',
          reply: reply || '',
          content: ev.content,
          creator: ev.pubkey,
          mentions: uniq(mentions),
          created: ev.created_at || Math.floor(Date.now() / 1000),
          decrypted: true
        };
      });

    const uniqueMessages = publicMessages.filter((msg, index, self) => 
      index === self.findIndex(m => m.id === msg.id)
    );

    if (uniqueMessages.length > 0) {
      this.emit(RavenEvents.PublicMessage, uniqueMessages);
    }
  }

  private async processDirectMessages(): Promise<void> {
    const directMessages: DirectMessage[] = (await Promise.all(
      this.eventQueue
        .filter(x => x.kind === NDKKind.EncryptedDirectMessage)
        .map(async ev => {
          const receiver = this.findTagValue(ev, 'p');
          if (!receiver) return null;

          const root = this.findNip10MarkerValue(ev, 'root');
          const mentions = this.filterTagValue(ev, 'p').map(x => x?.[1]).filter(notEmpty);
          const peer = receiver === this.pub ? ev.pubkey : receiver;

          const msg: DirectMessage = {
            id: ev.id,
            root: root || '',
            content: ev.content,
            peer,
            creator: ev.pubkey,
            mentions: uniq(mentions),
            created: ev.created_at || Math.floor(Date.now() / 1000),
            decrypted: false
          };

          if (this.isSyntheticPrivKey()) {
            return msg;
          }

          try {
            const decryptedContent = await this.decrypt(peer, ev.content);
            return {
              ...msg,
              content: decryptedContent,
              decrypted: true
            };
          } catch (error) {
            return msg;
          }
        })
    )).filter((msg): msg is DirectMessage => msg !== null);

    const validMessages = directMessages.filter(notEmpty);
    if (validMessages.length > 0) {
      this.emit(RavenEvents.DirectMessage, validMessages);
    }
  }

  private async processChannelMessageHides(): Promise<void> {
    const channelMessageHides: ChannelMessageHide[] = this.eventQueue
      .filter(x => x.kind === NDKKind.ChannelHideMessage)
      .map(ev => {
        const content = this.parseJson(ev.content);
        const id = this.findTagValue(ev, 'e');
        if (!id) return null;
        return {
          id,
          reason: content?.reason || ''
        };
      })
      .filter(notEmpty);

    if (channelMessageHides.length > 0) {
      this.emit(RavenEvents.ChannelMessageHide, channelMessageHides);
    }
  }

  private async processChannelUserMutes(): Promise<void> {
    const channelUserMutes: ChannelUserMute[] = this.eventQueue
      .filter(x => x.kind === NDKKind.ChannelMuteUser)
      .map(ev => {
        const content = this.parseJson(ev.content);
        const pubkey = this.findTagValue(ev, 'p');
        if (!pubkey) return null;
        return {
          pubkey,
          reason: content?.reason || ''
        };
      })
      .filter(notEmpty);

    if (channelUserMutes.length > 0) {
      this.emit(RavenEvents.ChannelUserMute, channelUserMutes);
    }
  }

  private async processReactions(): Promise<void> {
    const reactions: Reaction[] = this.eventQueue
      .filter(x => x.kind === NDKKind.Reaction)
      .map(ev => {
        const eventId = this.findTagValue(ev, 'e');
        if (!eventId) return null;
        return {
          id: ev.id,
          message: eventId,
          creator: ev.pubkey,
          content: ev.content,
          created: ev.created_at || Math.floor(Date.now() / 1000),
          peer: ev.pubkey
        };
      })
      .filter(notEmpty);

    if (reactions.length > 0) {
      this.emit(RavenEvents.Reaction, reactions);
    }
  }

  private async processEventDeletions(): Promise<void> {
    const eventDeletions: EventDeletion[] = this.eventQueue
      .filter(x => x.kind === NDKKind.EventDeletion)
      .map(ev => {
        const eventId = this.findTagValue(ev, 'e');
        if (!eventId) return null;
        return {
          eventId,
          why: ev.content || '',
          reason: ev.content || ''
        };
      })
      .filter(notEmpty);

    if (eventDeletions.length > 0) {
      this.emit(RavenEvents.EventDeletion, eventDeletions);
    }
  }

  private async processMuteList(): Promise<void> {
    const muteListEvents = this.eventQueue.filter(x => x.kind === NewKinds.MuteList);
    if (muteListEvents.length > 0) {
      const muteList: MuteList = {
        pubkeys: [],
        encrypted: ''
      };

      muteListEvents.forEach(ev => {
        const content = this.parseJson(ev.content);
        if (content) {
          muteList.pubkeys.push(...(content.pubkeys || []));
        }
      });

      this.emit(RavenEvents.MuteList, muteList);
    }
  }

  private async processChannelCreations(): Promise<void> {
    const channels: Channel[] = this.eventQueue
      .filter(x => x.kind === NDKKind.ChannelCreation)
      .map(ev => {
        const normalizedContent = this.normalizeMetadata(this.parseJson(ev.content));
        return {
          id: ev.id,
          created: ev.created_at || Math.floor(Date.now() / 1000),
          creator: ev.pubkey,
          ...normalizedContent
        };
      });

    if (channels.length > 0) {
      this.emit(RavenEvents.ChannelCreation, channels);
    }
  }

  private async processChannelUpdates(): Promise<void> {
    const channelUpdates: ChannelUpdate[] = this.eventQueue
      .filter(x => x.kind === NDKKind.ChannelMetadata)
      .map(ev => {
        const channelId = this.findTagValue(ev, 'e');
        if (!channelId) return null;
        const normalizedContent = this.normalizeMetadata(this.parseJson(ev.content));
        return {
          id: ev.id,
          creator: ev.pubkey,
          created: ev.created_at || Math.floor(Date.now() / 1000),
          channelId,
          ...normalizedContent
        };
      })
      .filter(notEmpty);

    if (channelUpdates.length > 0) {
      this.emit(RavenEvents.ChannelUpdate, channelUpdates);
    }
  }

  private findTagValue(event: NDKEvent, tagName: string): string | undefined {
    const tag = event.tags.find(t => t[0] === tagName);
    return tag?.[1];
  }

  private filterTagValue(event: NDKEvent, tagName: string): NDKTag[] {
    return event.tags.filter(t => t[0] === tagName);
  }

  private findNip10MarkerValue(event: NDKEvent, marker: string): string | undefined {
    const eTags = event.tags.filter(t => t[0] === 'e');
    const tag = eTags.find(t => t[3] === marker);
    return tag?.[1];
  }

  private parseJson(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private parseProfileContent(content: string): any {
    try {
      const parsed = JSON.parse(content);
      
      return this.normalizeMetadata(parsed);
    } catch (error) {
      return null;
    }
  }

  private normalizeMetadata(meta: any) {
    if (!meta || typeof meta !== 'object') {
      return {
        name: '',
        about: '',
        picture: '',
        nip05: ''
      };
    }
    
    return {
      name: typeof meta.name === 'string' ? meta.name : '',
      about: typeof meta.about === 'string' ? meta.about : '',
      picture: typeof meta.picture === 'string' ? meta.picture : '',
      nip05: typeof meta.nip05 === 'string' ? meta.nip05 : ''
    };
  }

  public async updateLeftChannelList(channelIds: string[]): Promise<void> {
    return;
  }

  public async updateReadMarkMap(map: ReadMarkMap): Promise<void> {
    if (!this.ndk || !this.relaysLoaded) {
      throw new Error('NDK not ready');
    }

    if (!this.ndk.signer) {
      throw new Error('No signer available');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NewKinds.Arbitrary;
      event.content = JSON.stringify(map);
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [['d', 'read-mark-map']];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      
      if (relaySet) {
        await event.publish(relaySet);
        this.emit(RavenEvents.ReadMarkMap, map);
      }
    } catch (error) {
      throw error;
    }
  }

  public listenMessages(messageIds: string[], relIds: string[]): void {
    if (!this.ndk || !this.relaysLoaded) return;

    const existingSub = this.subscriptions.find(sub => 
      sub.subId === 'messageListener'
    );
    if (existingSub) {
      existingSub.stop();
      this.subscriptions = this.subscriptions.filter(sub => sub !== existingSub);
    }

    if (messageIds.length === 0 && relIds.length === 0) return;

    const filters: NDKFilter[] = [
      {
        kinds: [
          NDKKind.EventDeletion,
          NDKKind.ChannelMessage,
          NDKKind.Reaction
        ],
        '#e': messageIds,
      },
      ...chunk(relIds, 10).map(c => ({
        kinds: [NDKKind.EventDeletion],
        '#e': c,
      }))
    ];

    const relaySet = this.createRelaySet(this.readRelays);
    if (!relaySet) return;

    const subscription = this.ndk.subscribe(filters, {
      closeOnEose: false,
      relaySet: relaySet
    });

    (subscription as any).subId = 'messageListener';
    this.subscriptions.push(subscription);

    subscription.on('event', (event: NDKEvent) => {
      this.pushToEventBuffer(event);
    });
  }

  public loadChannel(id: string): void {
    if (!this.ndk || !this.relaysLoaded) return;

    const filters: NDKFilter[] = [
      {
        kinds: [NDKKind.ChannelCreation],
        ids: [id]
      },
      {
        kinds: [NDKKind.ChannelMetadata, NDKKind.EventDeletion],
        '#e': [id],
      },
      {
        kinds: [NDKKind.ChannelMessage],
        '#e': [id],
        limit: MESSAGE_PER_PAGE
      }
    ];

    const relaySet = this.createRelaySet(this.readRelays);
    if (!relaySet) return;

    const subscription = this.ndk.subscribe(filters, {
      closeOnEose: true,
      relaySet: relaySet
    });

    (subscription as any).subId = `channel-${id}`;
    this.subscriptions.push(subscription);

    subscription.on('event', (event: NDKEvent) => {
      this.pushToEventBuffer(event);
    });
  }

  public async fetchProfile(pubkey: string): Promise<Profile | null> {
    if (!this.ndk || !this.relaysLoaded) return null;

    const filter: NDKFilter = {
      kinds: [NDKKind.Metadata],
      authors: [pubkey],
      limit: 1
    };

    try {
      const events = await this.fetchEventsWithTimeout([filter], 10000);
      
      if (events.length === 0) return null;

      const event = events[0];
      const normalizedContent = this.parseProfileContent(event.content);
      
      return {
        id: event.id,
        creator: event.pubkey,
        created: event.created_at || Math.floor(Date.now() / 1000),
        ...normalizedContent
      };
    } catch (error) {
      return null;
    }
  }

  public async hideChannelMessage(messageId: string, reason: string): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.ChannelHideMessage;
      event.content = reason;
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [['e', messageId]];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      
      if (relaySet) {
        await event.publish(relaySet);
        this.emit(RavenEvents.ChannelMessageHide, [{ id: messageId, reason }]);
      }
    } catch (error) {
      throw error;
    }
  }

  public async deleteEvents(eventIds: string[], reason: string = ''): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.EventDeletion;
      event.content = '';
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = eventIds.map(id => ['e', id]);

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      
      if (relaySet) {
        await event.publish(relaySet);
        this.emit(RavenEvents.EventDeletion, eventIds.map(id => ({ eventId: id, why: '' })));
      }
    } catch (error) {
      throw error;
    }
  }

  public async sendReaction(messageId: string, messageCreator: string, emoji: string): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.Reaction;
      event.content = emoji;
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [
        ['e', messageId],
        ['p', messageCreator]
      ];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      
      if (relaySet) {
        await event.publish(relaySet);
        this.emit(RavenEvents.Reaction, [{
          id: event.id,
          message: messageId,
          peer: messageCreator,
          content: emoji,
          creator: this.pub,
          created: event.created_at || Math.floor(Date.now() / 1000)
        }]);
      }
    } catch (error) {
      throw error;
    }
  }

  private canPublishEvents(): boolean {
    return !this.isSyntheticPrivKey() && !!this.ndk?.signer;
  }

  private async encrypt(pubkey: string, message: string): Promise<string> {
    return message;
  }

  private async decrypt(pubkey: string, encryptedMessage: string): Promise<string> {
    return encryptedMessage;
  }

  public async updateChannel(channel: Channel, meta: Metadata): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.ChannelMetadata;
      event.content = JSON.stringify(this.normalizeMetadata(meta));
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [
        ['e', channel.id, '', 'root'],
        ['a', `40:${channel.id}`]
      ];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);

      const updatedChannel: ChannelUpdate = {
        channelId: channel.id,
        ...channel,
        ...this.normalizeMetadata(meta)
      };
      this.emit(RavenEvents.ChannelUpdate, [updatedChannel]);
    } catch (error) {
      throw new Error(`Failed to update channel: ${error}`);
    }
  }

  public async updateMuteList(userIds: string[]): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NewKinds.MuteList;
      event.content = '';
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = userIds.map(userId => ['p', userId]);

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);

      // Emit mute list event
      const muteList: MuteList = {
        pubkeys: userIds,
        encrypted: ''
      };
      this.emit(RavenEvents.MuteList, muteList);
    } catch (error) {
      throw new Error(`Failed to update mute list: ${error}`);
    }
  }

  public async recommendRelay(address: string): Promise<void> {
    if (!this.canPublishEvents()) {
      throw new Error('Cannot publish events');
    }

    try {
      const event = new NDKEvent(this.ndk);
      event.kind = NDKKind.RecommendRelay;
      event.content = '';
      event.created_at = Math.floor(Date.now() / 1000);
      event.tags = [['r', address]];

      await event.sign();
      const relaySet = this.createRelaySet(this.writeRelays);
      await event.publish(relaySet);
    } catch (error) {
      throw new Error(`Failed to recommend relay: ${error}`);
    }
  }
}

export default NDKRaven;
