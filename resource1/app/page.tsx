"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function Home() {
  console.log("HOME PAGE RENDERED");

  const router = useRouter();

  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [capacity, setCapacity] = useState("");

  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingTypeId, setMeetingTypeId] = useState("");

  const [meetingTypes, setMeetingTypes] = useState<any[]>([]);

  useEffect(() => {
    async function fetchMeetingTypes() {
      try {
        const response = await fetch("/api/meeting-types");
        const data = await response.json();

        setMeetingTypes(data);
      } catch (error) {
        console.error(error);
      }
    }

    fetchMeetingTypes();
  }, []);

  const handleSearch = () => {
    if (
      !date ||
      !startTime ||
      !endTime ||
      !capacity ||
      !meetingTitle ||
      !meetingTypeId
    ) {
      alert("Please fill all fields");
      return;
    }

    if (endTime <= startTime) {
      alert("End time must be greater than start time");
      return;
    }

    if (Number(capacity) <= 0) {
      alert("Capacity must be greater than 0");
      return;
    }

    router.push(
      `/search-results?date=${date}` +
        `&start=${startTime}` +
        `&end=${endTime}` +
        `&capacity=${capacity}` +
        `&meetingTypeId=${meetingTypeId}` +
        `&title=${encodeURIComponent(meetingTitle)}`
    );
  };

  return (
    <div className="max-w-md mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold text-center">
        Book Based on Time
      </h1>

      <div>
        <label>Date</label>
        <Input
          type="date"
          min={new Date().toISOString().split("T")[0]}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      <div>
        <label>Start Time</label>
        <Input
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
        />
      </div>

      <div>
        <label>End Time</label>
        <Input
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
        />
      </div>

      <div>
        <label>Capacity</label>
        <Input
          type="number"
          placeholder="Enter capacity"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
      </div>

      <div>
        <label>Meeting Title</label>
        <Input
          type="text"
          placeholder="Enter meeting title"
          value={meetingTitle}
          onChange={(e) => setMeetingTitle(e.target.value)}
        />
      </div>

      <div>
        <label>Meeting Type</label>

        <select
          className="w-full border rounded p-2"
          value={meetingTypeId}
          onChange={(e) => setMeetingTypeId(e.target.value)}
        >
          <option value="">
            Select Meeting Type
          </option>

          {meetingTypes.map((type) => (
            <option
              key={type.meetingTypeId}
              value={type.meetingTypeId}
            >
              {type.meetingTypeName}
            </option>
          ))}
        </select>
      </div>

      <Button
        className="w-full"
        onClick={handleSearch}
      >
        Search
      </Button>

      <div className="flex justify-around border-t pt-4">
        <Button
          variant="outline"
          onClick={() => router.push("/rooms")}
        >
          Rooms
        </Button>

        <Button variant="outline">
          My Bookings
        </Button>

        <Button variant="outline">
          Account
        </Button>
      </div>
    </div>
  );
}









// "use client";

// import { useEffect, useState } from "react";
// import { useRouter } from "next/navigation";

// import { Input } from "@/components/ui/input";
// import { Button } from "@/components/ui/button";



// export default function Home() {
//   console.log("HOME PAGE RENDERED");
  
//   const router = useRouter();

//   const [date, setDate] = useState("");
//   const [startTime, setStartTime] = useState("");
//   const [endTime, setEndTime] = useState("");
//   const [capacity, setCapacity] = useState("");
//   const [meetingTypes, setMeetingTypes] = useState<any[]>([]);

//   const [meetingTitle, setMeetingTitle] = useState("");
// const [meetingTypeId, setMeetingTypeId] = useState("");

//   const handleSearch = () => {
//     // Validation
//     if (
//   !date ||
//   !startTime ||
//   !endTime ||
//   !capacity ||
//   !meetingTitle ||
//   !meetingTypeId
// ) {
//       alert("Please fill all fields");
//       return;
//     }

//     if (endTime <= startTime) {
//       alert("End time must be greater than start time");
//       return;
//     }

//     if (Number(capacity) <= 0) {
//       alert("Capacity must be greater than 0");
//       return;
//     }

//     router.push(
//   `/search-results?date=${date}&start=${startTime}&end=${endTime}&capacity=${capacity}&meetingTypeId=${meetingTypeId}&title=${encodeURIComponent(meetingTitle)}`
// );

//   useEffect(() => {
//   const fetchMeetingTypes = async () => {
//     const res = await fetch("/api/meeting-types");
//     const data = await res.json();
//     setMeetingTypes(data);
//   };

//   fetchMeetingTypes();
// }, []);

//   return (
//     <div className="max-w-md mx-auto p-6 space-y-4">

//       <h1 className="text-2xl font-bold text-center">
//         Book Based on Time
//       </h1>

//       <div>
//         <label>Date</label>
//         <Input
//   type="date"
//   min={new Date().toISOString().split("T")[0]}
//   value={date}
//   onChange={(e) => setDate(e.target.value)}
// />
//       </div>

//       <div>
//         <label>Start Time</label>
//         <Input
//           type="time"
//           value={startTime}
//           onChange={(e) => setStartTime(e.target.value)}
//         />
//       </div>

//       <div>
//         <label>End Time</label>
//         <Input
//           type="time"
//           value={endTime}
//           onChange={(e) => setEndTime(e.target.value)}
//         />
//       </div>

//       <div>
//         <label>Capacity</label>
//         <Input
//           type="number"
//           placeholder="Enter capacity"
//           value={capacity}
//           onChange={(e) => setCapacity(e.target.value)}
//         />
//       </div>

//       <div>
//   <label>Meeting Title</label>
//   <Input
//     type="text"
//     placeholder="Enter meeting title"
//     value={meetingTitle}
//     onChange={(e) => setMeetingTitle(e.target.value)}
//   />
// </div>

// <div>
//   <label>Meeting Type</label>

//   <select
//     className="w-full border rounded p-2"
//     value={meetingTypeId}
//     onChange={(e) => setMeetingTypeId(e.target.value)}
//   >
//     <option value="">Select Meeting Type</option>
//     {meetingTypes.map((type) => (
//   <option
//     key={type.meetingTypeId}
//     value={type.meetingTypeId}
//   >
//     {type.meetingTypeName}
//   </option>
// ))}
//   </select>
// </div>

//       <Button
//         className="w-full"
//         onClick={handleSearch}
//       >
//         Search
//       </Button>

//       <div className="flex justify-around border-t pt-4">
//         <Button
//   variant="outline"
//   onClick={() => router.push("/rooms")}
// >
//   Rooms
// </Button>
//         <Button variant="outline">My Bookings</Button>
//         <Button variant="outline">Account</Button>
//       </div>

//     </div>
//   );
// }
// }