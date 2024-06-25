import { NextRequest, NextResponse } from "next/server"
import {ZodTypeAny, z} from "zod"
import {GoogleGenerativeAI, HarmCategory, HarmBlockThreshold} from "@google/generative-ai"
import { EXAMPLE_ANSWER, EXAMPLE_PROMPT } from "./example";

const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY as string;

const genai = new GoogleGenerativeAI(apiKey);

const model = genai.getGenerativeModel({
    model:"gemini-1.5-flash"
})

const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
  };



export const GET = ()=>{
    return new Response("OK")
}


const determineSchemaType = (schema:any)=>{
    if(!schema.hasOwnProperty("type")){
        if(Array.isArray(schema)){
           return "array"
        }else{
            return typeof schema
        }
    }

    return schema.type

}

const jsonSchemaToZod = (schema:any): ZodTypeAny=>{

    const type = determineSchemaType(schema)

    switch (type) {
        case "string":
           return z.string().nullable()
        case "number":
            return z.number().nullable()   
        case "boolean":
            return z.boolean().nullable() 
        case "array":
            return z.array(jsonSchemaToZod(schema.items)).nullable()    
        case "object":
            const shape: Record<string, ZodTypeAny> = {}
            
            for (const key in schema){
                if(key !== "type"){
                    shape[key] = jsonSchemaToZod(schema[key])
                }
            }
            return z.object(shape)
    
        default:
            throw new Error(`Unsupported data type: ${type}`)
    }

}




export const POST = async (req:NextRequest)=>{
   const body = await req.json()
// step 1: make sure incoming request is valid

   const genericSchema = z.object({
     data:z.string(),
     format:z.object({}).passthrough(),
   })

   const {data, format} = genericSchema.parse(body)

// step 2: create a schema from the expected user format
   const dynamicSchema = jsonSchemaToZod(format)

// step 3: Retry Mechanism

type PromiseExecutor<T> =(
    resolve: (value:T)=>void,
    reject: (reason?: any)=>void
)=> void

class RetryablePromise<T> extends Promise<T> {
    static async retry<T>(
        retries: number,
        executor:PromiseExecutor<T>
    ): Promise<T>{
        return new RetryablePromise(executor).catch((error)=>{
            console.error(`Retrying due to error: ${error}`)

            return retries > 0 ? RetryablePromise.retry(retries - 1, executor) : RetryablePromise.reject(error) 
        })
    }
   
}

const validationResult = await RetryablePromise.retry<object>(5, async (resolve, reject)=>{
    try {
        // call  ai
        const text = `DATA: \n"${data}"\n\n-----------\nExpected JSON format: ${JSON.stringify(format, null, 2)}
\n\n-----------\nValid JSON output in expected format:`

       const chatSession = model.startChat({
        generationConfig,
        history:[

            {
                role:"user",
                parts:[{
                  text:EXAMPLE_PROMPT 
                }]
            },

            {
                role:"user",
                parts:[{
                    text:EXAMPLE_ANSWER
                }]
            },

            {
                role: "model",
                parts:[{  
                  text: "You are an AI agent that converts data into the attached JSON format. You respond with nothing but valid JSON based on the input data. Your output should DIRECTLY be valid JSON, nothing added before and after. You will begin with the opening curly brace and end with the closing curly brace. Only if you absolutely cannot determine a field, use the value null."
            }]
            },

          
            
        ]
       })

       const result = await chatSession.sendMessage(JSON.stringify(text))

   
    //    validate json
    const validationResult = dynamicSchema.parse(JSON.parse(result.response.text() || ""))
    return resolve(validationResult)
    } catch (error) {
       reject(error) 
    }
})

   return NextResponse.json(validationResult, {status:200})
}