'use client';
import { useEffect, useRef, useState } from 'react';
import type { Client } from './client';
export type ProjectionState<T> = {
  data: T | null;
  loading: boolean;
  error: string;
  refresh: () => void;
};
/** Scope-tagged snapshots hide the previous job synchronously on a job switch. */
export function useProjection<T>(client:Client,path:string|null,parse:(raw:string)=>T,refreshKey:unknown=0): ProjectionState<T> {
  const [snapshot,setSnapshot]=useState<{client:Client;path:string;value:T}|null>(null);
  const [state,setState]=useState<{client:Client;path:string;loading:boolean;error:string;refreshKey:unknown;retry:number}|null>(null);
  const [retry,setRetry]=useState(0);
  const sequence=useRef(0);
  useEffect(()=>{
    if (path === null) {
      setSnapshot(null);
      setState(null);
      return;
    }
    const version=++sequence.current, controller=new AbortController();
    const scope = {client,path,refreshKey,retry};
    setState({...scope,loading:true,error:''});
    const timer=setTimeout(()=>{
      if(sequence.current!==version)return;
      controller.abort();
      setState({...scope,loading:false,error:'Request timed out. Refresh to try again.'});
    },30_000);
    void client.extractionRequest(path,'GET',undefined,controller.signal).then(raw=>{
      if(sequence.current!==version || controller.signal.aborted)return;
      const value=parse(raw);
      setSnapshot({client,path,value});
      setState({...scope,loading:false,error:''});
    }).catch(()=>{
      if(sequence.current===version && !controller.signal.aborted) setState({...scope,loading:false,error:'Could not load data. Refresh to try again.'});
    }).finally(()=>clearTimeout(timer));
    return ()=>{++sequence.current;clearTimeout(timer);controller.abort();};
  },[client,path,parse,refreshKey,retry]);
  const current=state?.client===client && state.path===path && state.refreshKey===refreshKey && state.retry===retry ? state : null;
  return {data:snapshot?.client===client && snapshot.path===path ? snapshot.value:null,loading:current?.loading ?? true,error:current?.error ?? '',refresh:()=>setRetry(value=>value+1)};
}
export const humanize=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');

const activityTime = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
export function formatActivityTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? activityTime.format(timestamp) : value;
}
