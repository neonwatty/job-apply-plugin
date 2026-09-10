'use client';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
/** Scope-tagged snapshots hide the previous job synchronously on a job switch. */
export function useProjection<T>(client:Client,path:string,parse:(raw:string)=>T,refreshKey=0) {
  const [snapshot,setSnapshot]=useState<{client:Client;path:string;value:T}|null>(null);
  const [state,setState]=useState<{client:Client;path:string;loading:boolean;error:string}|null>(null);
  const [retry,setRetry]=useState(0);
  const sequence=useRef(0);
  useEffect(()=>{
    const version=++sequence.current, controller=new AbortController();
    setState({client,path,loading:true,error:''});
    const timer=setTimeout(()=>{
      if(sequence.current!==version)return;
      controller.abort();
      setState({client,path,loading:false,error:'The request timed out. Retry to load the latest information.'});
    },30_000);
    void client.extractionRequest(path,'GET',undefined,controller.signal).then(raw=>{
      if(sequence.current!==version || controller.signal.aborted)return;
      const value=parse(raw);
      setSnapshot({client,path,value});
      setState({client,path,loading:false,error:''});
    }).catch(()=>{
      if(sequence.current===version && !controller.signal.aborted) setState({client,path,loading:false,error:'Unable to load the latest information. Retry to refresh.'});
    }).finally(()=>clearTimeout(timer));
    return ()=>{++sequence.current;clearTimeout(timer);controller.abort();};
  },[client,path,parse,refreshKey,retry]);
  const current=state?.client===client && state.path===path ? state : null;
  return {data:snapshot?.client===client && snapshot.path===path ? snapshot.value:null,loading:current?.loading ?? true,error:current?.error ?? '',refresh:()=>setRetry(value=>value+1)};
}
export const humanize=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');
