/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createWorketFromSrc,
  registeredWorklets,
} from "./audioworklet-registry";

import {getMistyInstance} from "../misty/MistyProvider"

export class AudioStreamer {
  public audioQueue: Float32Array[] = [];
  private isPlaying: boolean = false;
  private sampleRate: number = 24000;
  private bufferSize: number = 7680;
  private processingBuffer: Float32Array = new Float32Array(0);
  private scheduledTime: number = 0;
  public gainNode: GainNode;
  public source: AudioBufferSourceNode;
  private isStreamComplete: boolean = false;
  private checkInterval: number | null = null;
  private initialBufferTime: number = 0.1; //0.1 // 100ms initial buffer
  private endOfQueueAudioSource: AudioBufferSourceNode | null = null;

  // private misty = getMistyInstance("10.134.71.231");
  // private isCollectingAudio = false; // 是否正在收集音频
  // private completeAudioBuffer = new Float32Array(0); // 存储完整句子的缓冲区
  // private silenceThreshold = 0.01; // 静音检测阈值
  // private silenceFrames = 0; // 连续静音帧计数
  // private silenceFramesThreshold = 30; // 判定为句子结束的静音帧数量（约1.25秒，基于24kHz采样率和缓冲区大小）
  // private sentenceMaxDuration = 10; // 最大句子长度（秒）
  // private sentenceStartTime = 0; // 句子开始时间

  public onComplete = () => {};

  constructor(public context: AudioContext) {
    this.gainNode = this.context.createGain();
    this.source = this.context.createBufferSource();
    this.gainNode.connect(this.context.destination);
    this.addPCM16 = this.addPCM16.bind(this);
  }

  async addWorklet<T extends (d: any) => void>(
    workletName: string,
    workletSrc: string,
    handler: T,
  ): Promise<this> {
    let workletsRecord = registeredWorklets.get(this.context);
    if (workletsRecord && workletsRecord[workletName]) {
      // the worklet already exists on this context
      // add the new handler to it
      workletsRecord[workletName].handlers.push(handler);
      return Promise.resolve(this);
      //throw new Error(`Worklet ${workletName} already exists on context`);
    }

    if (!workletsRecord) {
      registeredWorklets.set(this.context, {});
      workletsRecord = registeredWorklets.get(this.context)!;
    }

    // create new record to fill in as becomes available
    workletsRecord[workletName] = { handlers: [handler] };

    const src = createWorketFromSrc(workletName, workletSrc);
    await this.context.audioWorklet.addModule(src);
    const worklet = new AudioWorkletNode(this.context, workletName);

    //add the node into the map
    workletsRecord[workletName].node = worklet;

    return this;
  }

  addPCM16(chunk: Uint8Array) {
    const float32Array = new Float32Array(chunk.length / 2);
    const dataView = new DataView(chunk.buffer);

    for (let i = 0; i < chunk.length / 2; i++) {
      try {
        const int16 = dataView.getInt16(i * 2, true);
        float32Array[i] = int16 / 32768;
      } catch (e) {
        console.error(e);
        // console.log(
        //   `dataView.length: ${dataView.byteLength},  i * 2: ${i * 2}`,
        // );
      }
    }

    const newBuffer = new Float32Array(
      this.processingBuffer.length + float32Array.length,
    );
    newBuffer.set(this.processingBuffer);
    newBuffer.set(float32Array, this.processingBuffer.length);
    this.processingBuffer = newBuffer;

    // this.detectSentenceEnd(float32Array);

    // // 检查最大句子长度
    // if (Date.now() - this.sentenceStartTime > this.sentenceMaxDuration * 1000) {
    //   console.log("达到最大句子长度，处理当前音频");
    //   this.processSentence();
    // }

    while (this.processingBuffer.length >= this.bufferSize) {
      const buffer = this.processingBuffer.slice(0, this.bufferSize);
      this.audioQueue.push(buffer);
      this.processingBuffer = this.processingBuffer.slice(this.bufferSize);
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      // Initialize scheduledTime only when we start playing
      this.scheduledTime = this.context.currentTime + this.initialBufferTime;
      this.scheduleNextBuffer();
    }
  }

  private createAudioBuffer(audioData: Float32Array): AudioBuffer {
    const audioBuffer = this.context.createBuffer(
      1,
      audioData.length,
      this.sampleRate,
    );
    audioBuffer.getChannelData(0).set(audioData);
    return audioBuffer;
  }

  private scheduleNextBuffer() {
    const SCHEDULE_AHEAD_TIME = 0.2;

    while (
      this.audioQueue.length > 0 &&
      this.scheduledTime < this.context.currentTime + SCHEDULE_AHEAD_TIME
    ) {
      const audioData = this.audioQueue.shift()!;
      const audioBuffer = this.createAudioBuffer(audioData);
      const source = this.context.createBufferSource();

      if (this.audioQueue.length === 0) {
        if (this.endOfQueueAudioSource) {
          this.endOfQueueAudioSource.onended = null;
        }
        this.endOfQueueAudioSource = source;
        source.onended = () => {
          if (
            !this.audioQueue.length &&
            this.endOfQueueAudioSource === source
          ) {
            this.endOfQueueAudioSource = null;
            this.onComplete();
          }
        };
      }

      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const worklets = registeredWorklets.get(this.context);

      if (worklets) {
        Object.entries(worklets).forEach(([workletName, graph]) => {
          const { node, handlers } = graph;
          if (node) {
            source.connect(node);
            node.port.onmessage = function (ev: MessageEvent) {
              handlers.forEach((handler) => {
                handler.call(node.port, ev);
              });
            };
            node.connect(this.context.destination);
          }
        });
      }

      // i added this trying to fix clicks
      // this.gainNode.gain.setValueAtTime(0, 0);
      // this.gainNode.gain.linearRampToValueAtTime(1, 1);

      // Ensure we never schedule in the past
      const startTime = Math.max(this.scheduledTime, this.context.currentTime);
      source.start(startTime);

      this.scheduledTime = startTime + audioBuffer.duration;
    }

    if (this.audioQueue.length === 0 && this.processingBuffer.length === 0) {
      if (this.isStreamComplete) {
        this.isPlaying = false;
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
      } else {
        if (!this.checkInterval) {
          this.checkInterval = window.setInterval(() => {
            if (
              this.audioQueue.length > 0 ||
              this.processingBuffer.length >= this.bufferSize
            ) {
              this.scheduleNextBuffer();
            }
          }, 100) as unknown as number;
        }
      }
    } else {
      const nextCheckTime =
        (this.scheduledTime - this.context.currentTime) * 1000;
      setTimeout(
        () => this.scheduleNextBuffer(),
        Math.max(0, nextCheckTime - 50),
      );
    }
  }

  stop() {
    this.isPlaying = false;
    this.isStreamComplete = true;
    this.audioQueue = [];
    this.processingBuffer = new Float32Array(0);
    this.scheduledTime = this.context.currentTime;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.gainNode.gain.linearRampToValueAtTime(
      0,
      this.context.currentTime + 0.1,
    );

    setTimeout(() => {
      this.gainNode.disconnect();
      this.gainNode = this.context.createGain();
      this.gainNode.connect(this.context.destination);
    }, 200);
  }

  async resume() {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    this.isStreamComplete = false;
    this.scheduledTime = this.context.currentTime + this.initialBufferTime;
    this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
  }

  complete() {
    this.isStreamComplete = true;
    if (this.processingBuffer.length > 0) {
      this.audioQueue.push(this.processingBuffer);
      this.processingBuffer = new Float32Array(0);
      if (this.isPlaying) {
        this.scheduleNextBuffer();
      }
    } else {
      this.onComplete();
    }
  }

  // startCollecting() {
  //   this.isCollectingAudio = true;
  //   this.completeAudioBuffer = new Float32Array(0);
  //   this.silenceFrames = 0;
  //   this.sentenceStartTime = Date.now();
  //   console.log("开始收集音频数据");
  // }
  
  // // 停止收集并处理已收集的数据
  // stopCollecting() {
  //   this.isCollectingAudio = false;
  //   this.processSentence();
  // }

  // private detectSentenceEnd(buffer: Float32Array) {
  //   // 计算当前缓冲区的平均能量
  //   let energy = 0;
  //   for (let i = 0; i < buffer.length; i++) {
  //     energy += Math.abs(buffer[i]);
  //   }
  //   energy /= buffer.length;
    
  //   // 如果能量低于阈值，增加静音帧计数
  //   if (energy < this.silenceThreshold) {
  //     this.silenceFrames++;
      
  //     // 如果连续静音帧数量达到阈值，认为句子结束
  //     if (this.silenceFrames >= this.silenceFramesThreshold) {
  //       console.log("检测到句子结束（静音）");
  //       this.processSentence();
  //     }
  //   } else {
  //     // 重置静音帧计数
  //     this.silenceFrames = 0;
  //   }
  // }

  // private processSentence() {
  //   if (!this.isCollectingAudio || this.completeAudioBuffer.length === 0) return;
    
  //   console.log(`处理完整句子，长度: ${this.completeAudioBuffer.length} 样本`);
    
  //   // 转换Float32Array到适合Misty的格式（PCM16）
  //   const pcm16Data = this.float32ToPCM16(this.completeAudioBuffer);
    
  //   // 转换为Base64编码
  //   const base64Data = this.arrayBufferToBase64(pcm16Data);
    
  //   // 生成唯一文件名
  //   const timestamp = Date.now();
  //   const filename = `xxiong59_test_${timestamp}.mp3`;
    
  //   // 上传到Misty并播放
  //   this.uploadToMisty(base64Data, filename);
    
  //   // 重置状态，准备下一个句子
  //   this.startCollecting();
  // }

  // private float32ToPCM16(float32Array: Float32Array): ArrayBuffer {
  //   const pcm16 = new Int16Array(float32Array.length);
    
  //   for (let i = 0; i < float32Array.length; i++) {
  //     // 将-1.0到1.0的值转换为-32768到32767的整数
  //     const sample = Math.max(-1, Math.min(1, float32Array[i]));
  //     pcm16[i] = Math.round(sample * 32767);
  //   }
    
  //   return pcm16.buffer;
  // }
  
  // // 将ArrayBuffer转换为Base64字符串
  // private arrayBufferToBase64(buffer: ArrayBuffer): string {
  //   const bytes = new Uint8Array(buffer);
  //   let binary = '';
    
  //   for (let i = 0; i < bytes.byteLength; i++) {
  //     binary += String.fromCharCode(bytes[i]);
  //   }
    
  //   return window.btoa(binary);
  // }

  // private async uploadToMisty(base64Data: string, filename: string) {
  //   console.log(`上传音频到Misty: ${filename}`);
    
  //   // 使用队列或Promise链避免并发上传问题
  //   // const timestamp = Date.now();
  //   await this.misty?.uploadAudio(base64Data, filename)
  //   await this.misty?.playAudio(filename)
  // }

  // private handleStreamComplete() {
  //   console.log("音频流结束");
    
  //   // 如果还在收集状态且有数据，处理最后一个句子
  //   if (this.isCollectingAudio && this.completeAudioBuffer.length > 0) {
  //     this.processSentence();
  //   }
    
  //   this.isCollectingAudio = false;
  // }
}

// // Usage example:
// const audioStreamer = new AudioStreamer();
//
// // In your streaming code:
// function handleChunk(chunk: Uint8Array) {
//   audioStreamer.handleChunk(chunk);
// }
//
// // To start playing (call this in response to a user interaction)
// await audioStreamer.resume();
//
// // To stop playing
// // audioStreamer.stop();


