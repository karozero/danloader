import test from 'node:test';
import assert from 'node:assert/strict';
import {httpUrl,mediaKind,safeName,canonicalMediaUrl,playbackInfo,isVendorUrl} from '../dist/core/media.js';
import {parseHls,attributes} from '../dist/core/hls.js';
test('Reject non-network and credential-bearing candidates',()=>{
  for(const url of ['javascript:alert(1)','file:///etc/test','data:video/mp4,abc','https://user:pass@example.org/v'])assert.equal(httpUrl(url),null);
  assert.equal(httpUrl('../v.mp4','https://example.org/a/b'),'https://example.org/v.mp4');
});
test('Recognize manifests by MIME and URL without confusing segments',()=>{
  assert.equal(mediaKind('https://cdn.test/signed?id=1','application/vnd.apple.mpegurl'),'hls');
  assert.equal(mediaKind('https://cdn.test/v.mpd?token=1'),'dash');
  assert.equal(mediaKind('https://cdn.test/chunk.m4s'),null);
});
test('Safe filenames cannot escape the download directory',()=>{
  assert.equal(safeName('../CON:<>?.mp4'),'.._CON____.mp4');
  assert.equal(safeName('CON'),'video_CON.mp4');
  assert.equal(safeName('test.webm','webm'),'test.webm');
});
test('HLS selects independent audio and preserves signed URLs',()=>{
  const text='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="a,b",DEFAULT=YES,URI="audio.m3u8?sig=1"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,AUDIO="a",CODECS="avc1.42,mp4a.40"\nv/main.m3u8?sig=2\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\nlow.m3u8';
  const r=parseHls(text,'https://cdn.test/path/master.m3u8?token=parent');
  assert.equal(r.variants[0].height,1080);
  assert.equal(r.variants[0].audioUrl,'https://cdn.test/path/audio.m3u8?sig=1');
  assert.equal(r.variants[1].url,'https://cdn.test/path/low.m3u8');
  assert.equal(attributes('#EXT:CODECS="a,b",A=YES').CODECS,'a,b');
});
test('DRM, ordinary AES-128 and live playlists remain distinct',()=>{
  const prefix='#EXTM3U\n#EXTINF:2.5,\na.ts\n';
  assert.equal(parseHls(prefix,'https://a.test/a').live,true);
  assert.equal(parseHls(prefix+'#EXT-X-ENDLIST','https://a.test/a').duration,2.5);
  assert.equal(parseHls(prefix+'#EXT-X-KEY:METHOD=AES-128,URI="key"','https://a.test/a').drm,false);
  assert.equal(parseHls(prefix+'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"','https://a.test/a').drm,true);
  assert.throws(()=>parseHls('<html>login</html>','https://a.test'));
});
test('Captured Google byte ranges do not become media identities',()=>{
  const url='https://r.googlevideo.com/videoplayback?id=x&itag=137&range=100-200&sig=keep';
  assert.equal(canonicalMediaUrl(url),'https://r.googlevideo.com/videoplayback?id=x&itag=137&sig=keep');
  assert.equal(playbackInfo(url).needsAudio,true);
  assert.equal(playbackInfo(url.replace('itag=137','itag=18')).needsAudio,false);
});
test('Vendor domains are excluded, unrelated lookalikes are not',()=>{
  assert.equal(isVendorUrl('https://files.downloadhelper.net/a'),true);
  assert.equal(isVendorUrl('https://downloadhelper.net.example.org/a'),false);
});
