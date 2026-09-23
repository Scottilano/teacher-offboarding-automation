// Valid CSV of a chosen byte size, bounded row/field counts; all identities synthetic.
export function largeRoster(bytes) {
  const header=Buffer.from('Full Name,Email,Notes\n');
  const row=Buffer.from('Example Teacher,example@example.com,'+'x'.repeat(30000)+'\n');
  const count=Math.floor((bytes-header.length)/row.length);
  const buffer=Buffer.alloc(bytes,10);header.copy(buffer);
  for(let i=0;i<count;i++) row.copy(buffer,header.length+i*row.length);
  const offset=header.length+count*row.length;
  const prefix='Example Teacher,example@example.com,';
  if(bytes-offset>prefix.length) {buffer.write(prefix,offset);buffer.fill(120,offset+prefix.length,bytes-1);}
  return buffer;
}
