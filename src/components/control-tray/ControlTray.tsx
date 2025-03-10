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

import cn from "classnames";

import { memo, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { UseMediaStreamResult } from "../../hooks/use-media-stream-mux";
import { useScreenCapture } from "../../hooks/use-screen-capture";
import { useWebcam } from "../../hooks/use-webcam";
import { AudioRecorder } from "../../lib/audio-recorder";
import AudioPulse from "../audio-pulse/AudioPulse";
import "./control-tray.scss";
import {getMistyInstance} from "../../misty/MistyProvider"

export type ControlTrayProps = {
  videoRef: RefObject<HTMLVideoElement>;
  children?: ReactNode;
  supportsVideo: boolean;
  onVideoStreamChange?: (stream: MediaStream | null) => void;
};

type MediaStreamButtonProps = {
  isStreaming: boolean;
  onIcon: string;
  offIcon: string;
  start: () => Promise<any>;
  stop: () => any;
};

/**
 * button used for triggering webcam or screen-capture
 */
const MediaStreamButton = memo(
  ({ isStreaming, onIcon, offIcon, start, stop }: MediaStreamButtonProps) =>
    isStreaming ? (
      <button className="action-button" onClick={stop}>
        <span className="material-symbols-outlined">{onIcon}</span>
      </button>
    ) : (
      <button className="action-button" onClick={start}>
        <span className="material-symbols-outlined">{offIcon}</span>
      </button>
    ),
);

function ControlTray({
  videoRef,
  children,
  onVideoStreamChange = () => {},
  supportsVideo,
}: ControlTrayProps) {
  const videoStreams = [useWebcam(), useScreenCapture()];
  const [activeVideoStream, setActiveVideoStream] =
    useState<MediaStream | null>(null);
  const [webcam, screenCapture] = videoStreams;
  const [inVolume, setInVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [muted, setMuted] = useState(false);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const misty = getMistyInstance("");
  const { client, connected, connect, disconnect, volume } =
    useLiveAPIContext();
  
  useEffect(() => {
    if (!connected && connectButtonRef.current) {
      connectButtonRef.current.focus();
    }
  }, [connected]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--volume",
      `${Math.max(5, Math.min(inVolume * 200, 8))}px`,
    );
  }, [inVolume]);

  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        {
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        },
      ]);
    };
    if (connected && !muted && audioRecorder) {
      audioRecorder.on("data", onData).on("volume", setInVolume).start();
    } else {
      audioRecorder.stop();
    }
    const timer = setTimeout(() => {
      testProcessVideoFrame()
  }, 2000);
    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume);
    };
  }, [connected, client, muted, audioRecorder]);

  // useEffect(() => {
  //   if (videoRef.current) {
  //     videoRef.current.srcObject = activeVideoStream;
  //   }

  //   let timeoutId = -1;

  //   function sendVideoFrame() {
  //     const video = videoRef.current;
  //     const canvas = renderCanvasRef.current;

  //     if (!video || !canvas) {
  //       return;
  //     }

  //     const ctx = canvas.getContext("2d")!;
  //     canvas.width = video.videoWidth * 0.25;
  //     canvas.height = video.videoHeight * 0.25;
  //     if (canvas.width + canvas.height > 0) {
  //       ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
  //       const base64 = canvas.toDataURL("image/jpeg", 1.0);
  //       const data = base64.slice(base64.indexOf(",") + 1, Infinity);
  //       client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);
  //     }
  //     if (connected) {
  //       timeoutId = window.setTimeout(sendVideoFrame, 1000 / 0.5);
  //     }
  //   }
  //   if (connected && activeVideoStream !== null) {
  //     requestAnimationFrame(sendVideoFrame);
  //   }
  //   return () => {
  //     clearTimeout(timeoutId);
  //   };
  // }, [connected, activeVideoStream, client, videoRef]);

  //handler for swapping from one video-stream to the next
  const changeStreams = (next?: UseMediaStreamResult) => async () => {
    if (next) {
      const mediaStream = await next.start();
      setActiveVideoStream(mediaStream);
      onVideoStreamChange(mediaStream);
    } else {
      setActiveVideoStream(null);
      onVideoStreamChange(null);
    }
    misty?.startVedioStreaming(processVideoFrame)
    const timer = setTimeout(() => {
      misty?.stopVideoStreaming();
    }, 2000);
    videoStreams.filter((msr) => msr !== next).forEach((msr) => msr.stop());
  };

  function setAudioRecord(on: boolean) {
    setMuted(on)
  }

  function processVideoFrame(data: any) {
    const canvas = renderCanvasRef.current;
    if (canvas == null) {
      return;
    }
    const ctx = canvas?.getContext("2d")!;
    // Create a temporary image to load the frame
    const img = new Image();
    
    // When the image loads, draw it on the canvas
    img.onload = () => {
      // Set canvas dimensions if needed
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      
      // Draw the image on the canvas
      ctx.drawImage(img, 0, 0);
    };
    
    // Set the image source based on data type
    if (typeof data === 'string') {
      try {
        // Try to parse as JSON containing base64 image data
        const jsonData = JSON.parse(data);
        if (jsonData && jsonData.base64) {
          img.src = `data:image/jpeg;base64,${jsonData.base64}`;
        }
      } catch (jsonError) {
        // Not valid JSON, ignore
      }
    } else if (data instanceof Blob) {
      // Handle binary data as image blob
      img.src = URL.createObjectURL(data);
      
      // Clean up the URL object after the image loads
      img.onload = function() {
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
      };
    }
  }

  // 模拟测试函数
function testProcessVideoFrame() {
  // 创建一个简单的测试图像（一个红色的方块）
  const canvas = renderCanvasRef.current;
    if (canvas == null) {
      return;
    }
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  
  if (ctx) {
    // 填充红色背景
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 添加一些文本，确保我们能看见
    ctx.fillStyle = 'white';
    ctx.font = '24px Arial';
    ctx.fillText('Test Frame', 100, 120);
    
    // 转换为base64
    const base64Data = canvas.toDataURL('image/jpeg').split(',')[1];
    
    // 创建模拟的JSON数据（模拟Misty发送的数据格式）
    const mockJsonData = JSON.stringify({ base64: base64Data });
    
    // 调用处理函数
    console.log("Testing processVideoFrame with mock JSON data");
    processVideoFrame(mockJsonData);
    
    // // 也可以测试Blob格式
    // canvas.toBlob((blob) => {
    //   if (blob) {
    //     console.log("Testing processVideoFrame with mock Blob data");
    //     processVideoFrame(blob);
    //   }
    // }, 'image/jpeg');
  }
}

// 在组件挂载后或需要测试时调用
// 例如，可以添加一个测试按钮:
// <button onClick={testProcessVideoFrame}>Test with Mock Data</button>

  return (
    <section className="control-tray">
      <canvas style={{ display: "none" }} ref={renderCanvasRef} />
      <nav className={cn("actions-nav", { disabled: !connected })}>
        <button
          className={cn("action-button mic-button")}
          onClick={() => setMuted(!muted)}
        >
          {!muted ? (
            <span className="material-symbols-outlined filled">mic</span>
          ) : (
            <span className="material-symbols-outlined filled">mic_off</span>
          )}
        </button>

        <div className="action-button no-action outlined">
          <AudioPulse volume={volume} active={connected} hover={false} />
        </div>

        {supportsVideo && (
          <>
            <MediaStreamButton
              isStreaming={screenCapture.isStreaming}
              start={changeStreams(screenCapture)}
              stop={changeStreams()}
              onIcon="cancel_presentation"
              offIcon="present_to_all"
            />
            <MediaStreamButton
              isStreaming={webcam.isStreaming}
              start={changeStreams(webcam)}
              stop={changeStreams()}
              onIcon="videocam_off"
              offIcon="videocam"
            />
          </>
        )}
        {children}
      </nav>

      <div className={cn("connection-container", { connected })}>
        <div className="connection-button-container">
          <button
            ref={connectButtonRef}
            className={cn("action-button connect-toggle", { connected })}
            onClick={connected ? disconnect : connect}
          >
            <span className="material-symbols-outlined filled">
              {connected ? "pause" : "play_arrow"}
            </span>
          </button>
        </div>
        <span className="text-indicator">Streaming</span>
      </div>
    </section>
  );
}

export default memo(ControlTray);
