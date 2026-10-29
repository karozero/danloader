import {FormatInitializationMetadata,MediaHeader,VideoPlaybackAbrRequest,StreamProtectionStatus} from 'googlevideo/protos';
export const videoId='JPHT9AvoPSA';
export const video={itag:137,lastModified:'123',height:90,width:160,fps:30,mimeType:'video/mp4; codecs="avc1.42001e"',bitrate:100000,approxDurationMs:'2200'};
export const audio={itag:140,lastModified:'123',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:96000,audioQuality:'AUDIO_QUALITY_MEDIUM',approxDurationMs:'2200',audioChannels:2};
export const nativeBody=VideoPlaybackAbrRequest.encode({initializationFormatIds:[],bufferedRanges:[],selectedAudioFormatIds:[],selectedVideoFormatIds:[],selectedCaptionFormatIds:[],ssapPlaybackInfos:[],field1000:[],videoPlaybackUstreamerConfig:Uint8Array.of(1),streamerContext:{clientInfo:{clientName:1,clientVersion:'native-test'},poToken:Uint8Array.of(9,8,7),sabrContexts:[],unsentSabrContexts:[]}}).finish();
const int=n=>{if(n<128)return Buffer.from([n]);if(n<16384)return Buffer.from([128|(n&63),n>>>6]);if(n<2097152)return Buffer.from([192|(n&31),(n>>>5)&255,n>>>13]);if(n<268435456)return Buffer.from([224|(n&15),(n>>>4)&255,(n>>>12)&255,n>>>20]);throw Error('fixture too large');};
export const part=(type,body)=>Buffer.concat([int(type),int(body.length),body]);
export const protectedResponse=()=>part(58,StreamProtectionStatus.encode({status:3}).finish());
export function mediaResponse(videoBytes,audioBytes,{durationMs=2200,segmentNum=1,endSegmentNum=1,startMs=0,includeMetadata=true}={}){
 const output=[];for(const [index,format,data]of [[0,video,videoBytes],[1,audio,audioBytes]]){
  const formatId={itag:format.itag,lastModified:format.lastModified};
  if(includeMetadata)output.push(part(42,FormatInitializationMetadata.encode({videoId,formatId,mimeType:format.mimeType,endSegmentNum:String(endSegmentNum),endTimeTicks:String(startMs+durationMs*(endSegmentNum-segmentNum+1)),endTimeTimescale:'1000'}).finish()));
  output.push(part(20,MediaHeader.encode({videoId,formatId,itag:format.itag,headerId:index+1,segmentNum,startMs:String(startMs),durationMs:String(durationMs),segmentLengthBytes:String(data.length),isInitializationSegment:false}).finish()));
  output.push(part(21,Buffer.concat([Buffer.from([index+1]),data])),part(22,Buffer.from([index+1])));
 }return Buffer.concat(output);
}
