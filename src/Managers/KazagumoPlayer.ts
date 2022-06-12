import { Kazagumo } from '../Kazagumo';
import { KazagumoQueue } from './Supports/KazagumoQueue';
import { Player, Node, WebSocketClosedEvent, TrackExceptionEvent, PlayerUpdate, Filters } from 'shoukaku';
import {
  KazagumoError,
  KazagumoPlayerOptions,
  PlayerState,
  Events,
  PlayOptions,
  KazagumoSearchOptions,
  KazagumoSearchResult,
} from '../Modules/Interfaces';
import KazagumoTrack from './Supports/KazagumoTrack';

export default class KazagumoPlayer {
  /**
   * Kazagumo options
   */
  private options: KazagumoPlayerOptions;
  /**
   * Kazagumo Instance
   */
  private kazagumo: Kazagumo;
  /**
   * Shoukaku's Player instance
   */
  public shoukaku: Player;
  /**
   * The guild Id of the player
   */
  public readonly guildId: string;
  /**
   * The voice channel Id of the player
   */
  public voiceId: string | null;
  /**
   * The text channel Id of the player
   */
  public textId: string;
  /**
   * Player's queue
   */
  public readonly queue: KazagumoQueue;
  /**
   * Get the current state of the player
   */
  public state: PlayerState = PlayerState.CONNECTING;
  /**
   * Paused state of the player
   */
  public paused: boolean = true;
  /**
   * Loop status
   */
  public loop: 'none' | 'queue' | 'track' = 'none';
  /**
   * Search track/s
   */
  public search: (query: string, options?: KazagumoSearchOptions) => Promise<KazagumoSearchResult>;
  /**
   * Player's custom data
   */
  public readonly data: Map<string, any> = new Map();

  constructor(kazagumo: Kazagumo, player: Player, options: KazagumoPlayerOptions) {
    this.options = options;
    this.kazagumo = kazagumo;
    this.shoukaku = player;
    this.guildId = options.guildId;
    this.voiceId = options.voiceId;
    this.textId = options.textId;
    this.queue = new KazagumoQueue();

    this.search = this.kazagumo.search;

    this.shoukaku.on('start', (track) => {
      this.paused = false;

      const queues = [...this.queue];
      if (this.queue.current) queues.push(this.queue.current);
      if (this.queue.previous) queues.push(this.queue.previous);

      const kazagumoTrack = queues.find((q) => q.track === track.track);
      this.emit(Events.PlayerStart, this, kazagumoTrack);
    });

    this.shoukaku.on('end', (data) => {
      // This event emits STOPPED reason when destroying, so return to prevent double emit
      if (this.state === PlayerState.DESTROYING || this.state === PlayerState.DESTROYED)
        return this.emit(Events.Debug, `Player ${this.guildId} destroyed from end event`);

      if (data.reason === 'REPLACED') return this.emit(Events.PlayerEnd, this);
      if (['LOAD_FAILED', 'CLEAN_UP'].includes(data.reason)) {
        this.queue.previous = this.queue.current;
        this.paused = true;
        if (!this.queue.length) return this.emit(Events.PlayerEmpty, this);
        this.emit(Events.PlayerEnd, this, this.queue.current);
        this.queue.current = null;
        return this.play();
      }

      if (this.loop === 'track' && this.queue.current) this.queue.unshift(this.queue.current);
      if (this.loop === 'queue' && this.queue.current) this.queue.push(this.queue.current);

      this.queue.previous = this.queue.current;
      const currentSong = this.queue.current;
      this.queue.current = null;
      this.paused = false;

      if (this.queue.length) this.emit(Events.PlayerEnd, this, currentSong);
      else {
        this.paused = true;
        return this.emit(Events.PlayerEmpty, this);
      }

      this.play();
    });

    this.shoukaku.on('closed', (data: WebSocketClosedEvent) => {
      this.paused = true;
      this.emit(Events.PlayerClosed, this, data);
    });

    this.shoukaku.on('exception', (data: TrackExceptionEvent) => {
      this.paused = true;
      this.emit(Events.PlayerException, this, data);
    });

    this.shoukaku.on('update', (data: PlayerUpdate) => this.emit(Events.PlayerUpdate, this, data));
  }

  public get playing(): boolean {
    return !this.paused;
  }

  public get volume(): number {
    return this.shoukaku.filters.volume;
  }

  public get filters(): Filters {
    return this.shoukaku.filters;
  }

  private get node(): Node {
    return this.shoukaku.node;
  }

  private send(...args: any): void {
    this.node.queue.add(...args);
  }

  public pause(pause: boolean): KazagumoPlayer {
    if (typeof pause !== 'boolean') throw new KazagumoError(1, 'pause must be a boolean');

    if (pause) {
      if (this.paused) return this;
      this.paused = true;
      this.shoukaku.setPaused(true);
    } else {
      if (!this.paused) return this;
      this.paused = false;
      this.shoukaku.setPaused(false);
    }

    return this;
  }

  public setTextChannel(textId: string): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');

    this.textId = textId;

    return this;
  }

  public setVoiceChannel(voiceId: string): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');
    this.state = PlayerState.CONNECTING;

    this.voiceId = voiceId;
    this.kazagumo.KazagumoOptions.send(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.voiceId,
        self_mute: false,
        self_deaf: this.options.deaf,
      },
    });

    this.emit(Events.Debug, `Player ${this.guildId} moved to voice channel ${voiceId}`);

    return this;
  }

  public setLoop(loop: 'none' | 'queue' | 'track' | undefined): KazagumoPlayer {
    if (loop === undefined) {
      if (this.loop === 'none') this.loop = 'queue';
      else if (this.loop === 'queue') this.loop = 'track';
      else if (this.loop === 'track') this.loop = 'none';
      return this;
    }

    if (loop === 'none' || loop === 'queue' || loop === 'track') {
      this.loop = loop;
      return this;
    }

    throw new KazagumoError(1, "loop must be one of 'none', 'queue', 'track'");
  }

  public async play(track?: KazagumoTrack, options?: PlayOptions | undefined): Promise<KazagumoPlayer> {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');

    if (track && !(track instanceof KazagumoTrack)) throw new KazagumoError(1, 'track must be a KazagumoTrack');

    if (!track && !this.queue.totalSize) throw new KazagumoError(1, 'No track is available to play');

    if (!options || typeof options.replaceCurrent !== 'boolean') options = { replaceCurrent: false };

    if (track) {
      if (!options.replaceCurrent && this.queue.current) this.queue.unshift(this.queue.current);
      this.queue.current = track;
    } else if (!this.queue.current) this.queue.current = this.queue.shift();

    if (!this.queue.current) throw new KazagumoError(1, 'No track is available to play');

    const current = this.queue.current;
    current.setKazagumo(this.kazagumo);
    const resolveResult = await current.resolve().catch((e) => null);
    if (!resolveResult) {
      this.emit(Events.PlayerResolveError, current);
      return this.skip();
    }

    const playOptions = { track: current.track, options: {} };
    if (options) playOptions.options = { ...options, noReplace: false };
    else playOptions.options = { noReplace: false };

    this.shoukaku.playTrack(playOptions);

    return this;
  }

  public skip(): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');

    this.shoukaku.stopTrack();

    return this;
  }

  public setVolume(volume: number): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');
    if (isNaN(volume)) throw new KazagumoError(1, 'volume must be a number');

    this.shoukaku.filters.volume = volume / 100;

    this.send({
      op: 'volume',
      guildId: this.guildId,
      volume: this.shoukaku.filters.volume * 100,
    });

    return this;
  }

  public connect(): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYED) throw new KazagumoError(1, 'Player is already destroyed');
    if (this.state === PlayerState.CONNECTED || !!this.voiceId)
      throw new KazagumoError(1, 'Player is already connected');
    this.state = PlayerState.CONNECTING;

    this.kazagumo.KazagumoOptions.send(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.voiceId,
        self_mute: false,
        self_deaf: this.options.deaf,
      },
    });

    this.state = PlayerState.CONNECTED;

    this.emit(Events.Debug, `Player ${this.guildId} connected`);

    return this;
  }

  public disconnect(): KazagumoPlayer {
    if (this.state === PlayerState.DISCONNECTED || !this.voiceId)
      throw new KazagumoError(1, 'Player is already disconnected');
    this.state = PlayerState.DISCONNECTING;

    this.pause(true);
    this.kazagumo.KazagumoOptions.send(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    });

    this.voiceId = null;
    this.state = PlayerState.DISCONNECTED;

    this.emit(Events.Debug, `Player disconnected; Guild id: ${this.guildId}`);

    return this;
  }

  destroy(): KazagumoPlayer {
    if (this.state === PlayerState.DESTROYING || this.state === PlayerState.DESTROYED)
      throw new KazagumoError(1, 'Player is already destroyed');

    this.disconnect();
    this.state = PlayerState.DESTROYING;
    this.shoukaku.connection.destroyLavalinkPlayer();
    this.kazagumo.players.delete(this.guildId);
    this.state = PlayerState.DESTROYED;

    this.emit(Events.PlayerDestroy, this);
    this.emit(Events.Debug, `Player destroyed; Guild id: ${this.guildId}`);

    return this;
  }

  private emit(event: string, ...args: any): void {
    this.kazagumo.emit(event, ...args);
  }
}