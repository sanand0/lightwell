// @ts-check
// Save the function before parsing the body, as real calling apps can do.
const requestCamera = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);

// Playwright observes these references and pixel samples in the actual test consumer.
window.mockCall = { stream: null, peers: [], remote: null, requestCamera };

document.addEventListener("DOMContentLoaded", () => {
  const video = document.querySelector("#remote-view");
  const info = document.querySelector("#stream-info");
  const join = document.querySelector("#join");
  const audio = document.querySelector("#audio");
  const leave = document.querySelector("#leave");
  let session = 0;

  function hangUp() {
    session++;
    const call = window.mockCall;
    call.stream?.getTracks().forEach(track => track.stop());
    call.peers.forEach(peer => peer.close());
    call.stream = call.remote = null;
    call.peers = [];
    video.srcObject = null;
    join.disabled = audio.disabled = false;
    leave.disabled = true;
    info.textContent = "Call ended";
  }

  async function connect(stream, token) {
    const send = new RTCPeerConnection();
    const receive = new RTCPeerConnection();
    const remote = new MediaStream();
    Object.assign(window.mockCall, { peers: [send, receive], remote });
    video.srcObject = remote;
    receive.addEventListener("track", event => remote.addTrack(event.track));
    function forward(from, to) {
      from.addEventListener("icecandidate", event => {
        if (event.candidate && token === session) to.addIceCandidate(event.candidate).catch(() => {});
      });
    }
    forward(send, receive);
    forward(receive, send);
    for (const track of stream.getTracks()) send.addTrack(track, stream);
    await send.setLocalDescription(await send.createOffer());
    await receive.setRemoteDescription(send.localDescription);
    await receive.setLocalDescription(await receive.createAnswer());
    await send.setRemoteDescription(receive.localDescription);
  }

  async function start(hasVideo) {
    const token = ++session;
    join.disabled = audio.disabled = true;
    leave.disabled = false;
    info.textContent = "Waiting for media permission…";
    try {
      const stream = await requestCamera({
        video: hasVideo ? { width: { exact: 640 }, height: { exact: 360 }, frameRate: { ideal: 30 } } : false,
        audio: true,
      });
      if (token !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      window.mockCall.stream = stream;
      await connect(stream, token);
      if (token !== session) return;
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      info.textContent = (settings ? track.label + " · " + settings.width + " × " + settings.height + " video\n" : "Audio-only call\n") +
        stream.getAudioTracks().map(audio => audio.label + " · " + audio.readyState).join("\n");
    } catch (error) {
      if (token !== session) return;
      hangUp();
      info.textContent = error.name + ": " + error.message;
    }
  }

  join.addEventListener("click", () => void start(true));
  audio.addEventListener("click", () => void start(false));
  leave.addEventListener("click", hangUp);
  window.addEventListener("pagehide", hangUp);
});
