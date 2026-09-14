const mongoose=require('mongoose');
const InvoiceSchema=new mongoose.Schema({invoiceNumber:String,invoiceDate:Date,invoiceAmount:Number,buyerName:String,sellerName:String,buyerGSTIN:String,sellerGSTIN:String,invoiceType:String,partyId:{type:mongoose.Schema.Types.ObjectId,ref:'Party'},financialYear:String,month:String,originalFileName:String,driveFileId:String,driveFolderId:String,status:{type:String,default:'completed'},emailSent:{type:Boolean,default:false},emailSentAt:Date,emailStatus:String},{timestamps:true});
InvoiceSchema.index({invoiceNumber:1,invoiceAmount:1});
const PartySchema=new mongoose.Schema({name:{type:String,required:true},gstin:String,email:String,mobile:String},{timestamps:true});
const SettingSchema=new mongoose.Schema({key:{type:String,unique:true},value:String});
const UserSchema=new mongoose.Schema({username:String,passwordHash:String,name:String});
module.exports={Invoice:mongoose.model('Invoice',InvoiceSchema),Party:mongoose.model('Party',PartySchema),Setting:mongoose.model('Setting',SettingSchema),User:mongoose.model('User',UserSchema)};
