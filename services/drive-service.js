const {google}=require('googleapis');
const {Setting}=require('../models');

async function auth(){
    const row=await Setting.findOne({key:'google_tokens'});
    if(!row)throw new Error('Google account connect करें');
    const tokens=JSON.parse(row.value);
    const o=new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI);
    o.setCredentials(tokens);
    return o;
}

async function drive(){
    return google.drive({version:'v3',auth:await auth()});
}

async function ensureFolderPath(parts){
    const d=await drive();
    let parent='root',id='root';
    for(const name of parts){
        const r=await d.files.list({q:`name='${name.replace(/'/g,"\\'")}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,fields:'files(id,name)',pageSize:10});
        if(r.data.files.length){
            id=r.data.files[0].id;
        }else{
            const c=await d.files.create({requestBody:{name,mimeType:'application/vnd.google-apps.folder',parents:[parent]},fields:'id,name'});
            id=c.data.id;
        }
        parent=id;
    }
    return {id};
}

async function uploadFile(filePath,name,parent){
    const d=await drive();
    const r=await d.files.create({requestBody:{name,parents:[parent]},media:{mimeType:'application/pdf',body:require('fs').createReadStream(filePath)},fields:'id,name,webViewLink'});
    return r.data;
}

async function downloadFile(id){
    const d=await drive();
    const r=await d.files.get({fileId:id,alt:'media'},{responseType:'arraybuffer'});
    return Buffer.from(r.data);
}

// नया फंक्शन: Google Drive से फाइल डिलीट करने के लिए
async function deleteFile(fileId){
    const d = await drive();
    await d.files.delete({ fileId: fileId });
    return true;
}

module.exports={ensureFolderPath,uploadFile,downloadFile,deleteFile};