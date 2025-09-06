import sharp from 'sharp';
import axios from 'axios';
import FormData from 'form-data';

// CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
const cloud = process.env.CLOUDINARY_URL.split('@')[1];

async function process(buf){
  // подгон под 1080x1350 + лёгкий «киношный» обвес
  return await sharp(buf)
    .resize(1080,1350,{fit:'cover'})
    .modulate({ saturation:0.12, brightness:1 })
    .linear(1.1,-10)
    .jpeg({quality:90})
    .toBuffer();
}

async function upload(buf,name){
  const url=`https://api.cloudinary.com/v1_1/${cloud}/image/upload`;
  const form=new FormData();
  form.append('file',buf,{filename:name});
  // ⚠️ Создай в Cloudinary unsigned preset с именем "unsigned"
  form.append('upload_preset','unsigned');
  const {data}=await axios.post(url,form,{headers:form.getHeaders()});
  return data.secure_url;
}

export async function renderFinalSlides(selected){
  const out=[];
  for(let i=0;i<selected.length;i++){
    const s=selected[i];
    const raw=await axios.get(s.url,{responseType:'arraybuffer'}).then(r=>Buffer.from(r.data));
    const buf=await process(raw);
    out.push(await upload(buf,`slide_${i+1}.jpg`));
  }
  return out;
}
