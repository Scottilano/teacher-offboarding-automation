import {copyFile,constants} from 'node:fs/promises';
try {await copyFile('config.example.json','config.json',constants.COPYFILE_EXCL);console.log('Created config.json. Platforms default to read-only; an administrator must verify the scope before enabling removal.');}
catch(error){if(error.code==='EEXIST') console.log('config.json already exists; the existing configuration was preserved.');else throw error;}
