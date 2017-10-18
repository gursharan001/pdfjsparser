import 'pdfjs-dist';
import 'colors';
import * as moment from 'moment';
import * as underscore from 'underscore';
import * as fs from "async-file";
import * as path from 'path';
import * as domStubs from './domstubs';


interface textBlock { x1:number; y1:number; x2:number; y2:number; width:number;height:number, text:string };
interface line { number:number, y:number;  textBlocks:textBlock[], possiblyPartOfTable:boolean };
interface page { number:number;width:number;height:number; lines:line[]};
interface rectangle { x1:number, y1:number, x2:number, y2:number};
interface horizontalSpace {x1:number, x2:number};
type horizontalAlignment = "left" | "right";
interface column { x1:number; x2:number, firstY:number,lastY:number;horizontalAlignment:horizontalAlignment; startingTextBlocks:textBlock[]};
interface table { columns:column[], spacesBetweenColumns:horizontalSpace[]};

PDFJS.disableWorker =true;
domStubs.setStubs(global);


function possiblyPartOfBankStatementLinesTable ( line:line, windowLines:line[]) {
    if(line.number == 11 ){
        console.log("reached");
    }
    let isLineDistanceUniform=lineSpaceIsUniform(line, windowLines,0.8)
    let lineUniformHeight=getTextBlocksSameHeight(line);
    
    var potentialTable=getTable(line,windowLines);    
    var hasTable = !(!potentialTable);
    
    var hasTextInSpaceBetweenColumns=false;
    var hasDateColumnCloseToTheLeft= false;
    if (potentialTable){
        var hasTextInSpaceBetweenColumns=textBlocksInBetween(line.textBlocks,potentialTable.spacesBetweenColumns);
        hasDateColumnCloseToTheLeft=dateColumnExistCloseToTheLeft(potentialTable.columns);
    }

    let isPartOfBankStatementLinesTable=  lineUniformHeight && 
            potentialTable && 
            hasDateColumnCloseToTheLeft
            && !hasTextInSpaceBetweenColumns;
    
    console.log(`line=${line.number} window=${windowLines[0].number}-${underscore.last(windowLines).number} isPartOfBankStatementLinesTable=${isPartOfBankStatementLinesTable} hasTable=${hasTable} hasTextInSpaceBetweenColumns=${hasTextInSpaceBetweenColumns} isLineDistanceUniform=${isLineDistanceUniform} lineUniformHeight=${lineUniformHeight!=null} hasDate=${hasDateColumnCloseToTheLeft}`)
    return isPartOfBankStatementLinesTable;
}

function getSpacesBetweenColumns(columns:column[]):horizontalSpace[]{
    return columns.reduce(
     (accum:horizontalSpace[],column, idx)=>{
         if ( idx > 0 ){
            accum.push({x1:columns[idx-1].x2, x2:column.x1})
         }
         return accum;
     }   
    ,[])
}


function textBlocksInBetween(textBlocks:textBlock[], horizontalSpaces:horizontalSpace[]):boolean {
    return textBlocks.some(
        textBlock=>horizontalSpaces.some(horizontalSpace=>
            (textBlock.x1>horizontalSpace.x1 && textBlock.x2<horizontalSpace.x2)||
            (textBlock.x2>horizontalSpace.x1 && textBlock.x2<horizontalSpace.x2) 
        ));
}

function isInBetweenSpace(textBlocks:textBlock[],horizontalSpace:horizontalSpace):boolean{
    return textBlocks.some(
        textBlock=>
            (textBlock.x1>horizontalSpace.x1 && textBlock.x2<horizontalSpace.x2)||
            (textBlock.x2>horizontalSpace.x1 && textBlock.x2<horizontalSpace.x2) 
        ); 
}

function getTextBlocksSameHeight(line:line){
    let heightOfFirstBlock=line.textBlocks[0].height;
    if ( line
        .textBlocks
        .every(textBlock=>heightOfFirstBlock == textBlock.height))
    {
        return heightOfFirstBlock;
    }
    console.log(`line=${line.number} is not uniform`)
    return null;
}

function isLeftJustified ( textBlock:textBlock, leftJustifiedColumnXs:string[] ){
    return leftJustifiedColumnXs.some(x=> x==textBlock.x1.toString()); 
}  


function scanForPotentialColumns(line:line, windowLines:line[],minimumColumnarSpace=3, minimumContiguousLinesCount=3):table{
    var lines:line[]=[line];
    let firstLine=windowLines[0];
    let currentLineIdx=windowLines.findIndex(l=>l.number==line.number);
    var lineScanCount:number=2;
    let lastLine= underscore.last(windowLines);
    let lastLineIdx=windowLines.length-1;
    var scanDown=true;
    var columnarSpaces:horizontalSpace[]=getSpacesBetweenTextBlocks(line.textBlocks)
    
    var lineIdx=currentLineIdx;
    while(lineScanCount<=windowLines.length && lineIdx>=0){
        if(lineIdx > windowLines.length-1){
            scanDown=false;
        }
        if(scanDown){
            lineIdx++;
            columnarSpaces=getColumnarSpaces(windowLines[lineIdx],columnarSpaces);   
            lines.push()
        }
        else{
            lineIdx--;
            columnarSpaces=getColumnarSpaces(windowLines[lineIdx],columnarSpaces);
        }

        if(lineScanCount>=minimumContiguousLinesCount && columnarSpaces.length>minimumColumnarSpace){
            return {
                columns:null,
                spacesBetweenColumns:columnarSpaces
            }
        }

        if ( columnarSpaces.length<minimumColumnarSpace)
        
        lineScanCount++;
    }
    
    return null;
}

function getColumnarSpaces(line:line,existingColumnarSpaces:horizontalSpace[]):horizontalSpace[]{
    let newSpaces=getSpacesBetweenTextBlocks(line.textBlocks);
    return getOverlappingSpaces(newSpaces,existingColumnarSpaces);
}

function getOverlappingSpaces(newSpaces:horizontalSpace[],existingSpaces:horizontalSpace[]):horizontalSpace[]{
    return newSpaces
        .filter(space=>existingSpaces.some(existingSpace=>space.x1>=existingSpace.x1 && space.x2<=existingSpace.x1));
}

function getSpacesBetweenTextBlocks(sortedTextBlocks:textBlock[] ):horizontalSpace[]{
    return sortedTextBlocks.reduce((accum:horizontalSpace[],textBlock,idx)=>{
        if(idx>0){
            accum.push({x1:sortedTextBlocks[idx-1].x2,x2:textBlock.x1});
        }
        return accum;
    },[]);
}

function getPotentialColumns(windowTextBlocks:textBlock[],  
    minimumRepeatingLines=2,
    minimumColumns=3):column[]{
    
    let leftJustified= underscore.groupBy(windowTextBlocks, tb=>tb.x1 );
    let leftJustifiedColumnXs = Object.keys(leftJustified).filter((x)=> leftJustified[x].length >= minimumRepeatingLines);
    let leftJustifiedPossibleColumnsXCount=leftJustifiedColumnXs.length;
 
    let rightJustified=underscore.groupBy(windowTextBlocks, tb=>tb.x2 );
    // exlcude those that is also left justified
    let rightJustifiedColumnXs = Object.keys(rightJustified).filter((x)=> rightJustified[x].length >= minimumRepeatingLines
         && !isLeftJustified ( rightJustified[x][0], leftJustifiedColumnXs) );
         
    let rightJustifiedPossibleColumnsXCount=rightJustifiedColumnXs.length;
    if ( leftJustifiedPossibleColumnsXCount+rightJustifiedPossibleColumnsXCount>= minimumColumns ){
        var potentialColumnBlocks:column[]=[];
        leftJustifiedColumnXs.forEach(columnX=>potentialColumnBlocks.push(getColumn(columnX, 'left',  leftJustified[columnX])));
        rightJustifiedColumnXs.forEach( columnX=>potentialColumnBlocks.push(getColumn(columnX, 'right',rightJustified[columnX])));
        potentialColumnBlocks.sort((current,prev)=>current.x1-prev.x1);
        return potentialColumnBlocks;
    }
    return null;
}

function getTable(line:line,windowLines:line[]):table{
    let windowTextBlocks=windowLines.reduce(
        (accum:textBlock[],line)=>accum.concat(line.textBlocks)
       ,[]);
    var columns=getColumns(line,windowLines,windowTextBlocks);
    if(!columns){
        return null;
    }

    var spacesBetweenColumns= getSpacesBetweenColumns(columns);
    return {
        columns,
        spacesBetweenColumns  
    };
}

function getColumns(line:line, windowLines:line[], windowTextBlocks:textBlock[]):column[]{
    let potentialColumns = getPotentialColumns( windowTextBlocks);
    if(!potentialColumns){
        return null;
    }
    let spacesBetweenColumns=getSpacesBetweenColumns(potentialColumns);
    
    var columns:column[]=[];
    var arbitraryStartingX=potentialColumns[0].x1-1;
    if(horizontalSpaceExistsContiguouslyInLines({x1:arbitraryStartingX,x2:potentialColumns[0].x1}, windowLines)){
        columns.push(potentialColumns[0]);
    }
    else{
        console.log(`ignoring because column space is not contigous - column x1=${potentialColumns[0].x1} text=${potentialColumns[0].startingTextBlocks.map(t=>t.text).join(' ' )}`)
    }
    // remove columns if there are not contiguous lines where the column is succeeded by empty space  
    for(var idx=0;idx<spacesBetweenColumns.length;idx++){
        var column=potentialColumns.filter( column=>column.x1 == spacesBetweenColumns[idx].x2 )[0];
        if ( horizontalSpaceExistsContiguouslyInLines(spacesBetweenColumns[idx], windowLines)){
            columns.push(column);
        }
        else
        {
            console.log(`ignoring because column space is not contigous - column x1=${column.x1} text=${column.startingTextBlocks.map(t=>t.text).join(' ' )}`);
        }
    }
    return columns;
}

function horizontalSpaceExistsContiguouslyInLines(spacesBetweenColumn:horizontalSpace, windowLines:line[], minimumContiguousLinesCount=5):boolean{
    
    var contiguousLineCount=0; 
    for(var idx=0;idx<windowLines.length;idx++){
        if ( contiguousLineCount >=minimumContiguousLinesCount){
            return true;
        }
        var lineOverlapSpace=isInBetweenSpace( windowLines[idx].textBlocks, spacesBetweenColumn)
        if ( contiguousLineCount > 0 && lineOverlapSpace){
            return false;
        } 
        if(!lineOverlapSpace){
            contiguousLineCount++;
        }
    }
    throw "Unexpected code path execution in horizontalSpaceExistsContiguouslyInLines";
}


function getColumn(columnName:string, horizontalAlignment:horizontalAlignment, startingTextBlocks:textBlock[]):column {
    var firstY=Math.min(...startingTextBlocks.map(t=>t.y1));
    var lastY=Math.max(...startingTextBlocks.map(t=>t.y2))

    if(horizontalAlignment == 'left'){
        let maxX2=startingTextBlocks
                    .reduce((accum:number,current)=>{
                        if( accum < current.x2){
                            accum=current.x2;
                        }
                        return accum;
                    }, 0);

                                        
        let x1 = startingTextBlocks[0].x1;        
        return {
            x1:x1,
            x2:maxX2,
            firstY:firstY,
            lastY:lastY,
            horizontalAlignment:horizontalAlignment,
            startingTextBlocks:startingTextBlocks
        }        
    }

    let arbitraryLargeNumber=9999999;
    let minX1=startingTextBlocks
            .reduce((accum:number,current)=>{
                if( accum > current.x1){
                    accum=current.x1;
                }
                return accum;
            }, arbitraryLargeNumber );
    
    let x2= startingTextBlocks[0].x2;

    return {
        x1:minX1,
        x2:x2,
        firstY:firstY,
        lastY:lastY,
        horizontalAlignment:horizontalAlignment,
        startingTextBlocks:startingTextBlocks    
    }        
}

function pickWindowLines (currentLine:line,  allLines:line[],  windowLineCount:number=10):line[]{

    var lastLine = underscore.last(allLines);
    var firstLine= allLines[0];
    var start=currentLine.number-(windowLineCount/2);

    if ( start < firstLine.number ){
        start =  firstLine.number;
    }

    var last = start+(windowLineCount-1);
    if( last > lastLine.number  ){
        last=lastLine.number;
        start=last-windowLineCount;
        if(start<firstLine.number){
            start=firstLine.number;       
         }
    }
    
    return allLines.filter(l=>l.number>=start && l.number<=last);
}

function lineSpaceIsUniform ( line:line, windowLines:line[], tolerance:number ):boolean{
    interface distribution {[key:number]: number};

    interface accummulator {prevLine:line;highestOccurence:number;distribution:distribution};
    
    let accumulatedDistribution=windowLines.reduce(
        (accum:accummulator, line)=>{
            if (accum.prevLine){
                let height=line.y - line.textBlocks[0].height;
                let count=accum.distribution[height]||0;
                accum.distribution[height]=count+1;
                if (accum.highestOccurence && 
                    accum.distribution[height] > accum.distribution[accum.highestOccurence]){
                    
                    accum.highestOccurence=height;
                }

                if (!accum.highestOccurence){
                    accum.highestOccurence=height;
                }                
            }
            accum.prevLine = line;
            return accum;
        },{prevLine:null,highestOccurence:null,distribution:{}});
    
    let lineSpaceCount=(windowLines.length-1);
    let ratioOfTopOccurenceSpaceHeightCount= accumulatedDistribution.distribution[accumulatedDistribution.highestOccurence]/lineSpaceCount

    return (ratioOfTopOccurenceSpaceHeightCount>tolerance)
}

function dateColumnExistCloseToTheLeft(columns:column[], maximumColumnAwayFromLeft=2):boolean{
    
    for ( var idx=0;idx<columns.length && idx<maximumColumnAwayFromLeft;idx++){
        if ( moment(columns[idx].startingTextBlocks[0].text, ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD MMM YYY"]).isValid() ){
            return true;
        }
    }
    return false;
}

function transformTextContentItemsToSortedPageLines(textContentItems:TextContentItem[], pageHeight:number) {    
    // transform[5] = Y
    var textContentItemsGroupByY=underscore.groupBy(textContentItems, (c)=>c.transform[5]);
    var allYs = Object.keys(textContentItemsGroupByY);
    var lines:line[]=[];
    
    allYs.forEach(
        yText=>{
            // pick the first textblock to get the y
            let y=textContentItemsGroupByY[yText][0].transform[5];
            var line:line = {number:-1,y:y, possiblyPartOfTable:false,textBlocks:[]};

            // transform[4] is X, todo : remove rotated text
            textContentItemsGroupByY[yText]
                .sort((current,next)=>current.transform[4]-next.transform[4])
                .forEach(tc=>line.textBlocks.push({x1:tc.transform[4],y1:pageHeight-tc.transform[5],x2:tc.transform[4]+tc.width,y2:(pageHeight-tc.transform[5])+tc.height,width:tc.width, height:tc.height, text:tc.str}));
            lines.push(line);
        }
    );
    
    let sortedLines=lines
        .sort((current,next)=>next.y-current.y);
        
    sortedLines
        .forEach((l,idx)=>l.number=idx+1);

    return sortedLines;
}

function scanAndMarkLine(allLines:line[]){

    allLines.forEach(
        line=>{
            var windowLines=pickWindowLines(line, allLines)
            line.possiblyPartOfTable = possiblyPartOfBankStatementLinesTable(line, windowLines);
            console.log(`line=${line.number} ${line.textBlocks.map(b=>b.text).join(" ")}`)            
        }
    );

}

async function extractTable (){
    var buf=await fs.readFile(path.normalize("C:/scratch/GoogleVision/Carrier Invoices Samples/NOA_-_ANLS_-_Notice_of_Arrival_-_AEGIALI__-_196NNWANL_3353919103835000.pdf"))
    let pdfDocument= await PDFJS.getDocument(buf);
    var numPages=await pdfDocument.numPages;
    var pageNumber=1;
    var scale=1;
    var pages:page[] = [];
    while ( pageNumber<=numPages){
        let pdfPage=await pdfDocument.getPage(pageNumber);
        var viewPort = pdfPage.getViewport(scale);
        var page:page={number:pageNumber, height:viewPort.height, width:viewPort.width,lines:[] };
        pages.push(page);

        let textContents=await pdfPage.getTextContent();
        page.lines=transformTextContentItemsToSortedPageLines(textContents.items,page.height);
        console.log(`***** start of page ${pageNumber} *****`)
        scanAndMarkLine(page.lines);
        //page.lines.forEach(line=>console.log(` line=${line.number} ${line.textBlocks.map(b=>b.text).join(" ")}`));
        console.log(`***** endpage of page ${pageNumber} *****`)
        pageNumber++;
    }
    
}

extractTable();