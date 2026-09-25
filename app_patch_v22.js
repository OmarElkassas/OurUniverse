"use strict";
(function(){
  function cleanGameUI(root=document){
    root.querySelectorAll('.answer-grid,.answerbox').forEach(el=>el.remove());
    root.querySelectorAll('.prompt-question').forEach(el=>{
      el.textContent=el.textContent.replace(/\s*\[(?:fresh )?pack:[^\]]+\]\s*$/i,'').trim();
    });
  }
  cleanGameUI();
  new MutationObserver(mutations=>{
    for(const mutation of mutations){
      for(const node of mutation.addedNodes){
        if(node.nodeType===1) cleanGameUI(node);
      }
    }
  }).observe(document.documentElement,{childList:true,subtree:true});
})();
