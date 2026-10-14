import { registerChatRoutes as registerRoutes } from "./chat.js";

/** Older route-isolation tests intentionally supply only their exercised port.
 * Native SDK tests use the concrete store and never install these defaults. */
export async function registerChatRoutes(...args: Parameters<typeof registerRoutes>) {
 const store=args[1];
 const defaults={
  isRunning:()=>false,setNativeInputLifecycle(){},setBeforeNativeStream(){},nativeInputAllowed:async()=>{},
  nativeSessionCapability:async(id:string)=>({ownerAgentId:"manager",connectorId:"pi",nativePi:true,readOnly:false,busyInput:{modes:["followUp","steer"]},waiting:[],pendingMessageCount:0}),
  wireMessages:async(id:string)=>(await store.open(id)).messages,
  messageAdmission:async()=>undefined,
 };
 for(const [name,value] of Object.entries(defaults))if(typeof (store as unknown as Record<string,unknown>)[name]!=="function")Object.assign(store,{[name]:value});
 const invoker=args[5];if(invoker && !invoker.delegationsForManagerSession)Object.assign(invoker,{delegationsForManagerSession:async()=>[]});
 if(store.open){const rawOpen=store.open.bind(store);
 store.open=async(id:string)=>{const session=await rawOpen(id);if(session.isIdle===undefined)Object.assign(session,{isIdle:true});return session;};}
 return registerRoutes(...args);
}
