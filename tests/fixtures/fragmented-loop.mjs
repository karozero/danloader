// Repeat generated test fragments with continuous decode timestamps; never used by the extension.
export function loopFragmentedMp4(input,count){
 const boxes=(data,start=0,end=data.length)=>{const result=[];for(let at=start;at+8<=end;){const size=data.readUInt32BE(at),type=data.toString('ascii',at+4,at+8);if(size<8||at+size>end)throw Error('Invalid fixture box');result.push({at,size,type});at+=size;}return result;};
 const nested=(data,box)=>boxes(data,box.at+8,box.at+box.size);
 const find=(data,list,type)=>{for(const box of list){if(box.type===type)return box;if(['moof','moov','trak','mdia','minf','stbl','traf'].includes(box.type)){const result=find(data,nested(data,box),type);if(result)return result;}}};
 const top=boxes(input),mdhd=find(input,top,'mdhd');if(!mdhd)throw Error('No timescale');
 const timescale=input.readUInt32BE(mdhd.at+(input[mdhd.at+8]===1?28:20));
 const chunks=[];let ticks=0;
 for(let i=0;i<top.length;i++)if(top[i].type==='moof'){
  const moof=top[i],mdat=top[i+1];if(mdat?.type!=='mdat')throw Error('Expected mdat');
  const tfhd=find(input,[moof],'tfhd'),trun=find(input,[moof],'trun'),flags=input.readUInt32BE(tfhd.at+8)&0xffffff;
  let at=tfhd.at+16;if(flags&1)at+=8;if(flags&2)at+=4;const defaultDuration=flags&8?input.readUInt32BE(at):0;
  const runFlags=input.readUInt32BE(trun.at+8)&0xffffff,samples=input.readUInt32BE(trun.at+12);at=trun.at+16;if(runFlags&1)at+=4;if(runFlags&4)at+=4;
  for(let sample=0;sample<samples;sample++){ticks+=runFlags&256?input.readUInt32BE(at):defaultDuration;for(const flag of [256,512,1024,2048])if(runFlags&flag)at+=4;}
  chunks.push(input.subarray(moof.at,mdat.at+mdat.size));
 }
 if(!ticks||!chunks.length)throw Error('No fragment duration');
 const output=[input.subarray(0,top.find(b=>b.type==='moof').at)];let sequence=1;
 for(let loop=0;loop<count;loop++)for(const raw of chunks){
  const data=Buffer.from(raw),list=boxes(data),tfdt=find(data,list,'tfdt'),mfhd=find(data,list,'mfhd');
  data.writeUInt32BE(sequence++,mfhd.at+12);
  if(data[tfdt.at+8]===1)data.writeBigUInt64BE(data.readBigUInt64BE(tfdt.at+12)+BigInt(loop*ticks),tfdt.at+12);
  else data.writeUInt32BE(data.readUInt32BE(tfdt.at+12)+loop*ticks,tfdt.at+12);
  output.push(data);
 }
 return {data:Buffer.concat(output),duration:ticks*count/timescale};
}
